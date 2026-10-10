# UQSLA website

- `index.html`: the "big things coming soon" page
- `vote/`: AGM voting
  - `vote/` (attendees): enter a code, vote on the open position, wait for the next one
  - `vote/host.html` (exec): run the meeting one position at a time, add floor nominations, make codes
  - `vote/screen.html` (projector): welcome + check-in QR, the open position, then the results chart

## One-time Firebase setup

All in the [Firebase console](https://console.firebase.google.com/project/uqsla-98165) for `uqsla-98165`.

1. **Publish the security rules.** Realtime Database → Rules → paste the contents of `database.rules.json` → Publish.
   These rules are what stop duplicate codes, made-up codes, double voting, voting on a position that isn't open,
   and anyone without an access code from running the meeting.
2. **Turn on Anonymous sign-in.** Authentication → Sign-in method → Anonymous → Enable.
   Every phone, the host laptop and the projector sign in anonymously; the codes decide what each one can do.
   Email/Password isn't used.
3. **Make the two access codes.** Each code is **three or more random words**, lowercase, joined by hyphens,
   for example `mango-anchor-velvet-tide`. Pick unrelated words (not a phrase, and nothing about UQSLA or the AGM),
   or let your Mac pick them:

   ```bash
   python3 -c "import secrets; w=[l.strip().lower() for l in open('/usr/share/dict/words') if l.strip().isalpha() and 4<=len(l.strip())<=7]; [print(r, '-'.join(secrets.choice(w) for _ in range(4))) for r in ('host', 'screen')]"
   ```

   In Realtime Database → Data, add a child called `hostKeys`, and under it one entry per code:
   the **name** is the code, the **value** is `host` or `screen`. For example `hostKeys` → `<your host code>` → `host`.
   Type the name in lowercase with hyphens between words. On the gate page, capitals and spaces are fine.
   Never reuse a code that has appeared anywhere public.
4. **Authorised domains.** Authentication → Settings → Authorised domains → add your custom domain and `surfxce.github.io`.

The `apiKey` in `vote/firebase.js` is a public identifier, not a password. The rules are what protect the data.

### Access codes

- **Host code** (`host.html`): full control. Opening and closing votes, candidates, codes, resets. Keep it with the exec running the meeting.
- **Screen code** (`screen.html`): shows the projector view only. Safe to type on a laptop that's mirrored to the room;
  the worst someone could do with it is see vote counts before the reveal.
  The host code also works on the screen page.
- A browser stays unlocked until someone presses **Lock** (host page) or clears the browser's site data.
- **To revoke a code**, delete it from `hostKeys` in the console. Every browser using it is locked out immediately.
  Add a new code the same way. You can give each exec their own host code if you want to be able to cut off one person.

## On the day

1. **Before:** in the host page, add positions and candidates. Generate one code per expected member, then **Print new batch** and cut the slips.
2. **At the door:** hand each member one slip at random. The screen shows a QR code to `…/vote`.
3. **Each position:** after speeches, press **Open voting**. Phones show only that position.
   When the room is done, **Close voting**, then **Show results on screen**. The next press opens the next position.
4. **Floor nomination:** type the name into "Floor nomination" in the Live panel before opening voting for that position.
5. **Phone died:** release their code under Codes → Release a code, and they can enter it on another device.
   Votes they already cast stay counted and can't be cast twice.
6. **After a practice run:** Reset → Clear all votes (or clear codes too, if you printed test slips).

Results show the most votes as "Elected" and flag ties. Check this against the constitution's rules for majorities and uncontested positions.
For a yes/no vote on a single candidate, add a second candidate called "No" or "Re-open nominations".

## Testing locally

Needs the Firebase CLI and Java 21.

```bash
firebase emulators:start --only auth,database
python3 -m http.server 8765
```

Open `http://localhost:8765/vote/host.html?emulator`. The `?emulator` flag points the pages at the local emulators instead of the real database.
Use `http://127.0.0.1:8765/vote/?emulator` for a test attendee, so it signs in separately from the host tab.
