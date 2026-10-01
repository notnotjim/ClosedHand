---
name: Slack Workspace
description: Read Slack channels, search messages, and post to channels
requires_service: slack
triggers: [slack, channel, workspace, team chat, post message, slack message]
---

Use `api_request` with `service=slack` for all Slack API calls.
Base URL: `https://slack.com/api/`

## List Channels

```
GET https://slack.com/api/conversations.list?types=public_channel,private_channel&limit=100
```
Response: `channels[].id`, `name`, `is_private`, `num_members`, `topic.value`, `purpose.value`.

## Read Channel History

First join the channel (works for public channels), then read:
```
POST https://slack.com/api/conversations.join
Body: { "channel": "{channel_id}" }

GET https://slack.com/api/conversations.history?channel={channel_id}&limit=20
```
Response: `messages[].user`, `text`, `ts`, `thread_ts`, `reactions[].name/count`.
Max limit: 100.

## Search Messages

```
GET https://slack.com/api/search.messages?query={search_term}&count=20
```
Response: `messages.matches[].text`, `username`, `channel.name`, `ts`, `permalink`.

## Post Message (requires confirmation)

```
POST https://slack.com/api/chat.postMessage
Body: { "channel": "{channel_id}", "text": "Your message here" }
```
Join the channel first if needed. Response includes `ts` (message timestamp).
Non-GET requests will automatically require user confirmation via api_request.
