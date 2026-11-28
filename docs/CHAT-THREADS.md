# Chat Thread Management

This guide covers managing conversations (chat threads) in OpenDots, including how to delete one and what deletion removes.

## Delete a thread

1. Open the conversation you want to remove.
2. In the thread header, click the trash icon labelled **Delete conversation**.
3. Read the confirmation dialog and choose **Delete thread**, or **Cancel** to keep it.

After you confirm, the conversation fades out of **Recent chats** and disappears from the sidebar. If it was the open conversation, OpenDots returns to the Dot's start screen.

> **Deletion is permanent.** There is no undo or recovery window. The confirmation dialog says so before anything is removed.

### What is deleted

| Item                                                                                                              | Result                                                                                   |
| ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Conversation messages and run history                                                                             | Deleted from CopilotKit Intelligence                                                     |
| Conversation binding, scheduled-task link, voice call receipts, captured results, and MCP approval/action records | Deleted from the local workspace database                                                |
| Page-chat links and review receipts for the thread                                                                | Deleted                                                                                  |
| Saved pages created from the conversation                                                                         | **Kept.** Their "source conversation" link is cleared, and the page content is unchanged |

Saved pages are treated as your documents, so deleting a conversation never deletes them. Delete a page separately from its Space if you no longer want it.

### Permissions

OpenDots is a single-owner workspace. Every conversation belongs to the owner, so the owner can delete any of them. The API requires the owner access token when `OWNER_TOKEN` is configured. Multi-user roles, including separate admin permissions, are not part of this template yet.

### Repeated or simultaneous deletes

Deleting a conversation is idempotent. If two requests race, or a retry runs after a partial failure, the second request finishes the local cleanup and still succeeds rather than leaving stale rows behind.

## API

### `DELETE /api/threads/{threadId}`

Permanently deletes a conversation and the data listed above.

**Authentication:** `Authorization: Bearer <OWNER_TOKEN>` when an owner token is configured.

**Request:** no body is required. Send `Content-Type: application/json` with `{}` if you use a client that requires a JSON body, as the rest of the API does.

**Responses**

| Status                    | Meaning                                                                                                                            |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `204 No Content`          | The conversation was deleted. The body is empty.                                                                                   |
| `401 Unauthorized`        | The owner token is missing or wrong.                                                                                               |
| `403 Forbidden`           | The request came from a disallowed origin or host.                                                                                 |
| `404 Not Found`           | No conversation with this ID belongs to this workspace. Body: `{ "error": "Conversation does not belong to this Dot and owner." }` |
| `503 Service Unavailable` | Setup is incomplete, or CopilotKit Intelligence rejected the deletion. Nothing is removed locally, so you can retry.               |

**Example**

```sh
curl -i -X DELETE \
  -H "Authorization: Bearer $OWNER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{}' \
  http://127.0.0.1:4310/api/threads/3f0c6a2e-1d7b-4c1e-9a55-8e2b0c1f4d10
```

Expected result: `HTTP/1.1 204 No Content`.

Omit the `Authorization` header when no owner token is configured. Use the thread ID from `GET /api/workspace` (the `conversations[].id` field).

## Related

- [Setup](SETUP.md) — configure CopilotKit Intelligence, which stores conversation messages.
- [Data and privacy](../README.md#data-and-privacy) — what OpenDots stores locally and what Intelligence stores.
