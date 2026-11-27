# claude-swap

Swap a running Claude Code session between two claude.ai accounts. Type `/swap` and the next message goes out on the other account. You don't restart, and you keep the chat.

I use it to switch between a personal and a work plan, and to keep going on the other plan when one hits its usage limit.

## How it works

Claude Code stores its login in `<config dir>/.credentials.json` and re-reads it when the file changes. One account stays logged in to `~/.claude`, the other to a second dir (`~/.claude-second` by default). `/swap` exchanges the two logins.

The logins get swapped, never copied, and nothing else in the credentials file moves (MCP tokens stay where they are). It doesn't make any network calls. `/swap` is handled by a hook, so it doesn't use a model call either.

## Requirements

- Claude Code logged in with a claude.ai account
- Node 18+
- Windows or Linux

macOS doesn't work yet, because Claude Code keeps logins in the Keychain there. claude-swap will tell you that and leave things alone.

## Install

```sh
npx github:mkayultrah/claude-swap install --names "Personal,Work"
```

Or clone it and run `node install.js --names "Personal,Work"`.

The first name is the account you're already logged in with, the second is the one you're adding. Log the second one in:

```sh
claude-swap login
```

Pick the other account in the browser. Then restart any open Claude Code sessions.

The installer puts its files in `~/.claude-swap`. It adds hooks, a `/swap` command and a status line to `settings.json` in both dirs, and leaves the rest of the file alone. It backs up `settings.json` the first time. You can run it again any time.

If `~/.local/bin` is on your PATH you get a `claude-swap` command. If it isn't, use `node ~/.claude-swap/swap.js` instead.

Options:

```
--names "A,B"      account names (default Main,Second)
--second-dir DIR   where the second login lives (default ~/.claude-second)
--statusline       replace your status line with this one
--no-statusline    skip the status line
--uninstall        remove it
```

## Usage

```
/swap              switch accounts
/swap status       show which account you're on
/swap auto on      switch automatically when you hit a usage limit
/swap auto off
```

The same commands work in a terminal: `claude-swap status`, `claude-swap auto on` and so on.

Auto swap won't fire twice within 5 minutes, so two maxed-out accounts don't keep swapping back and forth. On Windows it also types a message into the session so it picks up where it left off. On Linux, send any message to continue.

Status line:

```
Work auto | 5h 42% 2h10 | 7d 18% 3d4h | ctx 23%
```

## Notes

- A swap affects every session using either dir, not just the one you typed it in.
- Claude Code adds the "Operation stopped by hook:" prefix itself.
- In Git Bash, `claude -p "/swap"` needs `MSYS_NO_PATHCONV=1`, otherwise Git Bash turns `/swap` into a file path.
- Every swap is logged to `~/.claude-swap/swap.log`.

## Uninstall

```sh
claude-swap uninstall
```

If the accounts are swapped, this swaps them back first. Then it removes the hooks, the command, the status line and `~/.claude-swap`. Your second login stays in `~/.claude-second`, so delete that folder if you don't need it.

## Tests

```sh
npm test
```

## License

MIT
