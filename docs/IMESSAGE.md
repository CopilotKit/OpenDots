# iMessage

Text a Dot from your phone. Apple has no iMessage API, so OpenDots connects through the Messages app on a Mac.

- **Receiving:** OpenDots reads new messages from the local Messages database. Access is read-only.
- **Replying:** it sends replies through Messages using AppleScript.

The bridge works only while OpenDots runs natively on that Mac and the Mac is signed in to Messages. It does not work in Docker or on a remote server.

## Setup

1. Sign in to Messages on the Mac with the Apple ID your Dot should text from. A spare Apple ID works best: messages you send to your own Apple ID can arrive twice.
2. Add the phone numbers or Apple ID emails that may reach your Dot to `.env`:

   ```bash
   IMESSAGE_HANDLES=+15551234567,me@icloud.com
   # IMESSAGE_DOT_ID=<a Dot id>   # defaults to the first Dot
   ```

3. Grant **Full Disk Access** to the app that starts OpenDots, such as Terminal, iTerm or your editor, in **System Settings → Privacy & Security → Full Disk Access**. Then restart that app.
4. Start OpenDots (`npm run dev` or `npm start`). The first reply asks you to allow the app to control **Messages**. Allow it.

**Settings & setup** shows the bridge's status. It reads `needs Full Disk Access` until step 3 is done.

## How it works

- The bridge checks for new messages every few seconds. Only allowlisted senders in one-to-one chats get answers. Group chats are ignored.
- Each sender gets one persistent Dot conversation, which you can also open in the web app. Send `/new` to start a fresh one.
- Several quick messages are combined into one turn. Replies are sent as plain text, with Markdown removed.
- Message history is never answered. On first start the bridge begins at the newest message. After a restart, messages older than an hour are skipped.
- When OpenDots is paused, the Dot replies that it is paused.
- Connection tools that need approval (see [Connections](CONNECTIONS.md)) cannot be approved over iMessage, so the Dot asks you to continue in the web app.

## Security notes

- Anyone who can send from an allowlisted number or email can talk to the Dot and use its permitted tools. Keep the list short.
- With Full Disk Access, the process running OpenDots can read your messages and other private files. Consider a separate macOS user account for OpenDots.
- Reply text is passed to AppleScript as an argument, never inserted into the script.
