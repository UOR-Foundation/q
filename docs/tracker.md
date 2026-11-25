# Open questions, promises and requests

Q keeps every question, promise and request made in a server's public channels open until a person answers or keeps it, so none is missed. Admins see what is open with `/open` and in a daily digest. Members' words go nowhere else.

## Why

A community loses trust in small ways: a newcomer's question nobody answered, an "I'll send it Friday" nobody remembered. Q already reads every public message, so it can hold each of these open until someone closes it.

## How

| Step | What happens | Decided by |
| --- | --- | --- |
| Catch | A message Q indexed that looks like one of the three goes to the language model. "Indexed" means a public channel and a human who has not opted out. The model names its kind and summarises it in one line, with a due date if the message names one. The model reads it with the six messages before it in the same place, so it can tell a real question or commitment from a reaction to the conversation. The bar is what an admin would regret missing: small talk, banter, disputes, quick clarifications and soft or conditional offers are left out. A cheap pattern check comes first, so most messages never reach the model. | decision 2 (what Q may keep) |
| Close | Someone else's reply answers a question or a request, and a ✅ from its author closes either. People often answer without Discord's reply, so a later message from someone else in the same channel or thread, within twelve hours, is read against the open items there, and closes each it answers. A promise closes only with a ✅, from the one who made it or the one it was made to. A bot never closes anything, and the asker's own reply never answers their question. | decision 30, `Policy.closeOnlyByHumans`, `Policy.promiseNeedsConfirmation`, `Policy.ownReplyNeverAnswers` (DA-36) |
| Show | `/open` lists what is open, by kind, oldest first, with who, how old, any due date and a link. It is for admins only and answered to the one who asked. A daily digest of the same goes to one admin channel. | command 9 (decision 4) |
| Forget | A deleted message takes its item with it, and `/forget-me` removes every item its author made. | as all of Q's memory |

Each item is a `uor-q/tracked/1` record named by its BLAKE3 label, and its closing is a `uor-q/tracked-close/1` record naming it.

## What it needs

- `TRACKER_GUILDS`: the server ids it is switched on for (`*` for all). Unset, it is off.
- `TRACKER_CHANNEL`: the admin channel for the digest, which Q must be able to post in. Unset, there is no digest.
- `TRACKER_DIGEST_HOUR`: the hour, in UTC, the digest goes (9 by default).
