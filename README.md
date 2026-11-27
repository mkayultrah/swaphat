<p align="center"><img src="assets/logo.svg" width="128" alt="swaphat"></p>

<h1 align="center">swaphat</h1>

<p align="center">Type <code>/swap</code> in Claude Code and the next message goes out on another account.<br>The session keeps running and the chat stays put.</p>

<p align="center"><img src="assets/demo.svg" width="760" alt="swapping accounts mid-chat"></p>

I have a personal Claude plan and a work one. I got sick of `/logout`, `/login`, losing my place, and doing it all again when a plan ran out halfway through something. Now I type `/swap`, or let it swap for me before I hit the limit.

## What it does

- `/swap` moves the session to your next account, and `/swap work` jumps straight to one. You can have as many accounts as you like.
- `/swap auto on` swaps for you, either before you hit the limit (at 95% by default) or right when you hit it. It always picks the account with the most room left.
- `/swap list` shows every account with its last known 5h and 7d usage.
- A status line shows which account you're on, its usage and your context.
- `swaphat doctor` tells you what's set up and what isn't.

It's plain Node with no dependencies. Nothing leaves your machine. `/swap` runs as a hook, so it doesn't use a model call. A swap takes about 0.1 s.

If you'd rather have a terminal dashboard and rotation strategies, take a look at [realiti4/claude-swap](https://github.com/realiti4/claude-swap). It's a bigger tool that works from outside Claude Code. swaphat is the in-chat one.

## How it works

Claude Code keeps its login in `~/.claude/.credentials.json`, or in the Keychain on macOS, and re-reads it when it changes. swaphat keeps your other logins parked: in `~/.swaphat/vault` on Windows and Linux, and in the Keychain on macOS. `/swap` puts the current login in the vault and the next one in its place. The session picks it up on its next message.

- A login only ever lives in one place. It's moved, never copied.
- Only the claude.ai login moves. MCP tokens and the rest of the file stay put. The account info `/status` shows moves along with it.
- A lock stops two swaps from clashing. If a write fails halfway, the swap is undone.
- It won't save the same account twice. The same email in two orgs counts as two accounts, which is how Team plans work.

## Install

Needs Node 18+ and Claude Code logged in with a claude.ai account (Pro, Max, Team or Enterprise).

```sh
npx github:mkayultrah/swaphat install --names Personal
```

or clone it and run `node install.js --names Personal`. That names the account you're logged in with right now. Then add the others:

```sh
swaphat add Work
```

That opens the usual Claude login in your browser. Pick the account you want, and swaphat saves it. Do it again for each account. Then restart any open Claude Code sessions so they load the hook.

Already have an account logged in to another config dir? Run `swaphat add Work --from ~/.claude-work` to move it in.

If `~/.local/bin` is on your PATH you get a `swaphat` command. It usually is if you installed Claude Code with its own installer. If it isn't, use `node ~/.swaphat/swap.js`.

The installer copies itself to `~/.swaphat`, then adds two hooks, a `/swap` command and a status line to `~/.claude/settings.json`. The rest of the file stays as it is. It backs the file up once, won't touch a `settings.json` it can't parse, and is safe to run again.

```
--names "A,B"      account names; the first is the one logged in now
--second-dir DIR   also run Claude from DIR and swap between the two dirs
--statusline       replace your current status line
--no-statusline    don't add the status line
```

## Usage

In Claude Code:

```
/swap              next account
/swap work         that account (a prefix works too)
/swap list         all accounts, where they are, last usage
/swap status       which account this session is on
/swap auto on      swap at 95% or when a limit hits
/swap auto 85      same, at 85%
/swap auto off
/swap doctor       check the setup
```

From a terminal: the same, plus `swaphat add <name>` and `swaphat remove <name>`.

Auto swap won't fire twice within 5 minutes. If every other account is over the line too, it stays where it is.

```
$ swaphat list
* Personal  ~/.claude        5h 96%  7d 41%  (just now)
  Work      saved            5h 12%  7d 33%  (2h ago)
  Spare     saved            5h 0%   7d 5%   (1d ago)
auto swap on at 95%
```

## Platforms

| | |
|---|---|
| Windows | tested end to end |
| Linux | same layout as Windows, covered by CI |
| macOS | Keychain swaps tested in CI against a real keychain. I haven't used it in a live session on a Mac yet |

## Things to know

- Every session on `~/.claude` swaps together, since they share one login.
- Claude Code adds the "Operation stopped by hook:" bit itself.
- The usage numbers come from the status line, so an account's numbers are only as fresh as the last time you used it.
- From Git Bash, `claude -p "/swap"` needs `MSYS_NO_PATHCONV=1`, otherwise Git Bash turns `/swap` into a file path.
- Every swap goes in `~/.swaphat/swap.log`.

## Uninstall

```sh
swaphat uninstall
```

Saved accounts get moved out to `~/.claude-<name>` so you don't lose them. You can use one with `CLAUDE_CONFIG_DIR=~/.claude-work claude`. Then it removes the hooks, the command, the status line and `~/.swaphat`.

## Tests

```sh
npm test
```

27 tests covering about 87% of the code. They run in a throwaway home dir, so your real logins are never touched.

## License

MIT
