# Recorded walkthroughs

Recorded from the local OpenDots app on September 29, 2026. The recordings use a dedicated `opendots` Intelligence project, a live `gpt-5.4-mini` model, and example content in a separate Launch studio Space. No customer data or credentials are shown.

| Recording                                    | Flow                                                                                | Duration   | Framing |
| -------------------------------------------- | ----------------------------------------------------------------------------------- | ---------- | ------- |
| [Chat to Space](chat-to-space.mp4)           | Ask Scout to browse, review the proposed draft, approve it, and open the saved page | 23 seconds | 150%    |
| [Specialist chat](specialist-chat.mp4)       | Continue launch planning with Scout and receive a live follow-up response           | 13 seconds | 150%    |
| [Spaces and page chat](spaces-page-chat.mp4) | Open a Space and page, ask about the saved brief, then continue under Scout         | 19 seconds | 135%    |
| [Computer chat](computer-chat.mp4)           | Browse a website, save notes, and verify the file through chat                      | 34 seconds | 150%    |

The recordings show the updated plush avatars and separate Dots, Spaces, and recent-chat navigation. Space-access settings preserve existing grants. The computer demo uses Scout with browser, file, and shell access enabled for its own container.

The README embeds compact GIF versions. MP4 versions are included for playback and reuse. These are screen-capture walkthroughs. The hero omits four seconds of idle footage and plays at 1.2×; the other clips play at 1.25×. Pauses between capture segments are also omitted. These edits show the workflow, not a model-latency benchmark. No assistant responses or tool results are fabricated or replaced. Each video is cropped around its active components at the listed magnification relative to the original 1280-pixel-wide capture; GIFs use the same framing. The captures are sampled at four frames per second, so they are intended to show workflows rather than animation performance. They have no audio.

## Chat-to-Space hero

[Chat to Space](chat-to-space.mp4) follows one live natural-language request:

> Visit https://www.copilotkit.ai in your computer. Draft “Launch in three steps”: one goal and three milestones, under 80 words. Show it for my approval before saving in Launch studio.

Scout opens the website in its existing OpenBot computer. CopilotKit `useRenderTool` displays the browser inline, and `useHumanInTheLoop` presents the draft with **Approve & save** and **Decline**. The recording shows approval, the saved-page receipt, and the finished Space page. The page also survived a reload after recording.

Approval uses an owner-authenticated route, checks the Dot's current Space access, and deduplicates saves by thread and tool call. Reconnecting recovers an existing approval before offering a new decision. Slack does not receive this web-only review tool.

## Chat-driven computer demo

[Computer chat](computer-chat.mp4) (34 seconds) uses the existing CopilotKit `useAgent` / `useCopilotKit` chat and server tools. The OpenBot computer is provisioned before recording. Only these two natural-language messages drive the workflow:

1. “Open https://www.copilotkit.ai in your computer and tell me what it offers in two short bullets.”
2. “Save those notes as copilotkit-notes.md on your computer. Use your terminal to verify the file, then tell me where it is and how many words it contains.”

Scout navigates, summarizes the page, writes the file, and executes a terminal check. Its real reply reports `/workspace/copilotkit-notes.md` and 41 words; an independent container command confirmed both. No manual browser navigation, file editing, or terminal command entry appears in this recording. CopilotKit `useRenderTool` and `CopilotChatToolCallsView` render the computer directly inside the conversation: a live browser card, a file receipt, and terminal output. The side panel stays closed. Tool results and responses are not scripted.

The final recording was captured after correcting host-to-supervisor networking and documenting snapshot recovery following a computer restart. Earlier failed takes are not part of the clip. Between the two chat requests, recording pauses were omitted; the revised clip accelerates the captured footage to 1.25× without changing its sequence.

## What was verified

- The provided model credential authenticated successfully.
- A dedicated hosted Intelligence project and project-scoped runtime key were provisioned through the CopilotKit CLI.
- Specialist chat returned a live model response.
- The page assistant received the saved document context and returned relevant milestones.
- The launch brief remained saved after a browser reload.
- The page conversation and its model response reloaded from Intelligence after refreshing the browser.

- Live OpenBot computer provisioning, browser navigation, file creation, and shell execution succeeded.
- A saved workspace file retained identical contents across a stop/start (checked separately from the recording).
- Browser work resumed after restart using a fresh snapshot.

Slack is not demonstrated. Spoken compute delegation and full interruption behavior still need dedicated live checks.

## Voice call UI test

[Voice call](voice-call.mp4) (15 seconds) is a silent screen capture of a real browser WebRTC call using `gpt-realtime-2.1`. It shows connection, elapsed time, separate user and Dot captions, microphone and speaker mute, minimize/expand, hang-up, and the saved receipt. The microphone was muted during the controls sequence; the visible spoken input and replies came from the live session. Capture uses two screenshots per second; waiting time is trimmed and playback is accelerated to 1.25×. The clip is not a latency benchmark and does not contain recorded audio.

Live checks on September 30, 2026 confirmed two-way microphone/audio in an earlier mic check, live captions, working controls, clean provider hang-up, and a saved transcript with no call error. The final receipt and assistant summary survived a reload in the same Intelligence thread. A separate real server turn verified the Node-compatible Intelligence agent used for receipt sync and compute; spoken `ask_compute` delegation was not demonstrated in this clip.

Calls stop microphone transmission and pause output immediately when ending, then release the WebRTC peer after the server hang-up request. Captions and callbacks from an ended session cannot update a later call. Keys stay server-side and are not included in recordings.

## Re-recording

Use a separate example Space and specialist. Verify the model and Intelligence connection before recording. Keep Settings, environment files, credential pages, and unrelated windows out of the capture. Record the actual app, inspect every segment, and update the verification date and scope when replacing the assets. Never replace failed or missing responses with scripted output.
