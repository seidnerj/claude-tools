# openSession on macOS: design notes and gating-layer reference

This document explains why `src/terminal-launcher.ts` looks the way it does. It records (a) the design we settled on, (b) the failed approaches we rejected and why, and (c) the macOS gating layers that turn "obvious" implementations into silent failures. Future maintainers reading this should be equipped to evaluate alternatives without re-running the diagnostic loop that produced this design.

## Goal

Open a new terminal window in the user's preferred macOS terminal app, run `claude --rc <session-name>` in the workspace directory, and replicate the behavior the user would see if they typed those commands themselves. "Replicate" specifically means:

- The user's full login + interactive shell init runs (`.zprofile`, `.zshenv`, `.zshrc`, `.zlogin` for zsh; `.bash_profile`, `.bashrc` for bash).
- `chpwd` hooks fire on `cd` (so direnv loads the workspace's `.envrc` if present).
- `claude` is found on the user's actual PATH, not launchd's stripped PATH.
- The launcher returns a kill-handle PID so callers can terminate the entire spawned session with a single `kill`.

## Final design (current code)

```
osascript -> default-profile window in iTerm2 (preferred) or Terminal.app
          -> "write text" / "do script" delivers `cd <ws> && claude --rc ...`
          -> AppleScript returns the new session's tty
          -> ps -t <tty> resolves the session leader's PID
```

The two macOS handlers are `macos-iterm` (preferred when `/Applications/iTerm.app` or `~/Applications/iTerm.app` exists) and `macos-default` (Terminal.app fallback). Both go through `launchMacosViaOsascript()`.

iTerm path:

```applescript
tell application "iTerm"
  set s to current session of (create window with default profile)
  tell s to write text "cd '<ws>' && 'claude' '--rc' '<name>'"
  return tty of s
end tell
```

Terminal.app path:

```applescript
tell application "Terminal"
  set t to do script "cd '<ws>' && 'claude' '--rc' '<name>'"
  return tty of t
end tell
```

`create window with default profile` (iTerm) and `do script` (Terminal) both spawn a window using the user's default profile. That profile invokes `login -fp <user>` which gives the shell its login flag, producing the full ancestry `login -> -zsh -> claude --rc`. This ancestry is byte-identical to a window the user opens manually.

`write text` and `do script` deliver the command line as if typed at the prompt. Because the shell is interactive, `PROMPT_COMMAND` (bash) and `precmd_functions` / `chpwd_functions` (zsh) all fire normally. direnv loads `.envrc` on the `cd`. Aliases, prompt customizations, and PATH from `.zshrc` are all in place.

The command line ends with `; exit` so the shell terminates unconditionally once claude returns - cleanly (`/exit`, iOS-side close), via signal (Cmd+W on the window, `kill <terminalPid>`), or on crash. The terminal session ends, and the window's fate is governed by the profile's "When session ends" setting (typically Close, sometimes Hold). We use `;` rather than `&&` because openSession is primarily an unattended/MCP-driven tool: leaving orphan windows behind on the rare crash case is worse UX than auto-closing.

The PID we return (`terminalPid`) is the **session leader** for the new tty - the only process on that tty whose parent is _not_ also on the tty. Killing it sends SIGHUP through the controlling-tty foreground group; the shell receives it, propagates to claude, and the entire session tears down with one signal.

## Why iTerm2 is preferred over Terminal.app

There is a `claude --rc` bug specific to Terminal.app: when launched under `Apple_Terminal`, the spawned RC session fights for the host account's RC slot, producing repeated `Transport closed (code 4090)` disconnects. The same command from iTerm2 routes through an iTerm2-specific code path in claude that doesn't trigger the collision. So we always prefer iTerm2 when it is installed.

## Approaches we tried and rejected

These are listed in roughly the order we explored them. Each was rejected for a _specific_ reason that future maintainers should not have to rediscover.

### 1. `open -b com.googlecode.iterm2 <file>.command`

The original attempt (commit 48e5192). Write a `.command` shell script to `os.tmpdir()`, then dispatch via `open -b` to force iTerm to handle it.

**Failure mode 1: Gatekeeper-style "OK to run X.command?" dialog.** iTerm gates execution of unknown `.command` files behind a modal warning. Each launch generates a new UUID-named file, so iTerm treats every launch as a new untrusted file and re-prompts. From an unattended or remote session, the prompt is invisible and `spawnSync("open", [...])` returns `status: 0` while the dialog sits unanswered.

**Failure mode 2: Even after the prompt is approved, env is stripped.** iTerm's `command` execution path runs the program directly under launchd's environment, which has only `/usr/bin:/bin:/usr/sbin:/sbin:/Applications/iTerm.app/Contents/Resources/utilities` on PATH. `claude` lives in `~/.local/bin` (the modern installer's default location). The `.command` script exits immediately with `command not found`.

**Failure mode 3: `open -b` is a request, not a command.** LaunchServices only routes `.command` execution to apps that bind the `Shell` role for `com.apple.terminal.shell-script`. iTerm declares the UTI but at lower-priority roles (Editor); only Terminal.app binds the Shell role on stock macOS. So `open -b com.googlecode.iterm2` can silently fall through to LaunchServices' default and route to Terminal.app, or no-op entirely, depending on macOS version.

### 2. iTerm `create window with default profile command "<path>"`

Skip `open` entirely and use iTerm's AppleScript API directly, passing the script path via the `command` argument.

**Failure mode: same env-stripping as approach 1.** iTerm's `command` argument exec's the program _instead of_ the user's shell - there is no shell init, no `.zshrc`, no PATH augmentation. We tested this directly: a `.command` script that captured `$PATH` saw exactly the launchd path and could not find `claude`.

The lesson: iTerm's `command` parameter is for "run this binary with no shell." It is not equivalent to "type this command at the user's prompt."

### 3. Wrap with `${SHELL:-/bin/bash} -lc <cmd>`

Modify the `.command` script to re-exec via the user's login shell, so `.zprofile` / `.bash_profile` would set PATH.

**Failure mode: `-l` is not enough on modern shells.** Most users add `~/.local/bin`, `/opt/homebrew/bin`, mise/asdf shims, etc. in `.zshrc` or `.bashrc` - files that login shells _don't_ source unless they are also interactive. We tested with `zsh -lc`: the resulting PATH was missing `~/.local/bin` entirely. Adding `-i` (interactive) brings issues: bash prints job-control warnings to stderr in `-ic` mode, and on Linux specifically, bash's direnv hook is `PROMPT_COMMAND`-based and never fires in `-c` mode because no prompt is ever drawn.

### 4. Bake `process.env.PATH` into the launcher script

Snapshot the spawning process's PATH (which inherits from the user's shell context) and `export PATH=...` at the top of the `.command` script.

**Failure mode: PATH alone isn't the user's environment.** This works for finding `claude`, but bypasses `.zshrc` aliases, prompt customizations, and crucially direnv. A workspace with an `.envrc` containing API keys would not get them loaded. The result looks superficially correct (claude starts, RC connects) but does not match what the user gets in a real iTerm window.

### 5. Final design: open default-profile window, send command line as text

This is the design now in `terminal-launcher.ts`. iTerm's `create window with default profile` (no `command` parameter) spawns the window using the user's default profile, which itself invokes `login -fp <user>` and runs the user's shell as login + interactive. The shell goes through full init. Then `write text` delivers the `cd <ws> && claude ...` line as if the user typed it at the prompt.

We confirmed end-to-end on a workspace with `.envrc`:

- `DIRENV_DIR` and `DIRENV_FILE` were set in the spawned `claude --rc` process's environment, proving the chpwd hook fired during the simulated `cd`.
- Process ancestry: `login -fp jonathanseidner -> -zsh -> claude --rc <name>`. Identical to manual launch.
- `kill <terminalPid>` (where `terminalPid` is `login`'s PID) cleanly tore down the entire tree.

## macOS gating layers a launcher must contend with

Multiple independent macOS subsystems can intercept a process spawn and produce silent-success-then-blocked behavior. Each of them is async with respect to the spawning process, so `spawnSync` returns `status: 0` while a modal is queued. Knowing they exist saves hours of debugging.

### Gatekeeper / quarantine on `.command` files

**Trigger:** opening a `.command` file via LaunchServices that the system has not seen before, or that has the `com.apple.quarantine` extended attribute. Files written by a process whose parent app is sandboxed often get this attribute automatically.

**Symptom:** iTerm/Terminal shows a "Warning: OK to run X?" dialog with a "Suppress this message permanently" checkbox. The dialog is per-file, so every UUID-named launcher re-prompts.

**Bypass:** don't write `.command` files in the first place. Our final design has no temp file at all; the command is embedded in the AppleScript string.

### TCC Automation prompts

**Trigger:** any process sending Apple Events to control another process. macOS attributes the request to the _responsible process_ (typically the foreground app or the app that invoked the script), not the literal `osascript` binary. So `osascript` invoked from a Claude Code MCP server's child process gets attributed to Claude Code.

**Symptom:** "<Source App> wants to control <Target App>" dialog. The user can Allow or Don't Allow. Approval persists until revoked via System Settings -> Privacy & Security -> Automation.

**Bypass:** none, and we don't try. The prompt fires at most once per source-target app pair, ever. In practice, by the time a user invokes `openSession`, they have likely already approved Claude Code -> iTerm via some other Claude Code feature.

**Detecting denial:** when the user clicks Don't Allow, `osascript` exits non-zero with stderr containing `Not authorized to send Apple events`. Our `TerminalLaunchError` will surface that text. A friendlier error message is a possible enhancement (see [issue #5](https://github.com/seidnerj/claude-tools/issues/5)).

### LaunchServices role bindings

**Trigger:** routing a file via `open` to an app that doesn't bind the right role for that file's UTI.

**Symptom:** silent no-op. `open -b <bundle>` tells LaunchServices "use this bundle if it claims the file type" - but if the bundle only claims it as Editor and not Shell, LaunchServices may fall through or do nothing visible, returning success either way.

**Bypass:** don't use `open` for execution dispatch. AppleScript sidesteps LaunchServices entirely and talks directly to the target app's scripting interface.

### TMPDIR is per-user, not `/tmp`

**Trigger:** writing files via `os.tmpdir()` in Node and looking for them under `/tmp`.

**Symptom:** files appear to "vanish" - they're actually in `/var/folders/<hash>/T/`, not `/tmp`. macOS gives each user a private TMPDIR via launchd. Bash's `/tmp` is a symlink to `/private/tmp`, which is unrelated.

**Bypass:** if you need to inspect tmp files written by a Node process, query the process's `$TMPDIR` (`ps -E -p <pid>` shows env vars) rather than guessing. Our final design avoids tmp files entirely, sidestepping this confusion class.

## tty -> session-leader PID resolution

We use `ps -t <ttyname> -o pid=,ppid=` and pick the entry whose `ppid` is _not_ among the tty's pids. That entry is the controlling-tty root process - the one that called `setsid()` to become session leader. Killing it sends SIGHUP through the foreground process group, taking down the shell and claude in one signal.

We deliberately avoid `ps -o sid=`. BSD `ps` (macOS) does not have a `sid` keyword - only `sess`, which is a kernel-pointer address rather than a session ID. The "parent not on this tty" heuristic works portably because the kernel always has exactly one such entry per tty (the entry point that called `setsid`).

The tty itself is obtained from AppleScript: iTerm sessions and Terminal tabs both expose a `tty` property like `/dev/ttys013`. We strip the `/dev/` prefix before passing to `ps -t`.

## What about Linux and Windows?

Out of scope for now. Linux has no portable AppleScript-equivalent for "open default-profile window then send keystrokes" - each terminal exposes a different mechanism (gnome-terminal D-Bus, kitty's `kitten @`, `xdotool`/`ydotool` keystroke injection on X11/Wayland). Windows Terminal's `wt.exe new-tab --startingDirectory ... cmd /k "claude --rc"` is feasible. See [issue #5](https://github.com/seidnerj/claude-tools/issues/5) for the acceptance criteria each new platform handler must meet.

The previous `linux-xdg` and `linux-alt` handlers were removed because they did not meet those criteria: `bash -c` skipped login + interactive init, missed direnv, hardcoded bash, and could not return a kill handle. A handler that "works" but silently strips the user's environment produces worse user-facing behavior than a clean `NoGUITerminalError` pointing the user at `claude --rc` in their shell.

## Diagnostic methodology (for next time)

A few techniques that paid off and are worth remembering:

- **Live launcher inspection.** When a temp script is suspected to vanish too fast, query the spawning process's `$TMPDIR` (not your shell's), then run a tight `find` loop with `cp` to a known location. This caught the `/var/folders` vs `/tmp` confusion.
- **Test the AppleScript path manually.** `osascript -e 'tell application "iTerm" to count windows'` is a one-line probe for whether iTerm is reachable and TCC-approved. Doing this before debugging code saves time.
- **Process ancestry as success signal.** A correctly launched `claude --rc` should show ancestry `login -> -zsh -> claude` (or your shell). Anything else (e.g., `bash -> claude` directly) means the shell init was bypassed. Use `ps -o pid,ppid,command -p <claude-pid> ...` walking up `ppid` until you hit a non-tty parent.
- **`lsof -p <pid>` to verify RC connection.** A live RC session has multiple ESTABLISHED HTTPS connections to Anthropic's API endpoint. Absence of those connections is a strong signal that claude started but failed to connect.
- **Two pending dialogs aren't always blocking the path you think.** macOS prompts are per-source-target pair (TCC) or per-file (Gatekeeper). A pending prompt can be from a completely unrelated diagnostic command and may not gate openSession at all. Read the dialog text carefully and trace which command produced it before assuming.

## Files

- `src/terminal-launcher.ts` - macOS-only handler implementations, AppleScript dispatch, `findSessionLeaderPid`.
- `src/open-session.ts` - public `openSession()` API, trust-check guard, args composition.
- `src/types.ts` - `OpenSessionResult` includes `terminalPid` and `terminalTty`.
- `src/tests/terminal-launcher.test.ts` - mocked tests covering both handlers, error paths, and non-macOS rejection.
