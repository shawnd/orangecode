# Aggregate session activity

Integrations that display whether a session is finished should use aggregate
activity rather than foreground execution status. An idle foreground can still
be waiting for a background agent or shell.

## API

- Compatibility API: `GET /session/:sessionID/activity`, available as
  `client.session.activity({ sessionID })` in `@opencode-ai/sdk/v2`.
- Current API: `GET /api/session/:sessionID/activity`, available as
  `client.sessions.activity({ sessionID })` in `@opencode-ai/client` and its
  Effect entrypoint. The HTTP response wraps the value in `{ "data": ... }`;
  these clients return the value directly.

Both endpoints return the same activity value:

```json
{
  "type": "working",
  "foreground": "idle",
  "agents": 2,
  "shells": 1
}
```

The boundary is the requested session and all of its descendants, including
nested agents outside the client's session-list filter. Unrelated sessions,
ancestors, and siblings do not contribute.

## State precedence

1. `blocked`: an outstanding permission or question in the subtree needs input.
2. `working`: foreground execution, a descendant agent, or a background shell is
   active. Retrying agents count as working.
3. `idle`: no active work or outstanding interaction remains.

`foreground` reports only execution of the requested session: `working` or
`idle`. `agents` counts distinct active descendant sessions, deduplicating agent
execution and background-job ownership. `shells` counts running detached shell
jobs throughout the subtree, including shells whose owning agent has finished.
Completed, failed, and cancelled jobs do not contribute. A historical tool part
is not evidence of live work.

This is a process-local observation. It does not confer execution ownership,
resume a session, or recover jobs after a restart. Foreground status, execution
events, and prompt scheduling retain their existing meanings.

## Integration usage

Poll this endpoint for the selected session while displaying its state, including
after a foreground idle event. Foreground events alone cannot signal detached
shell completion. Use `type` for the overall indicator and the other fields for
details such as "waiting on 2 agents and 1 shell".

The full TUI's built-in Herdr integration polls this endpoint when `HERDR_ENV=1`
and the pane/socket variables are present. It publishes aggregate activity over
Herdr's socket, including while the foreground is idle, and keeps observing the
selected subtree when navigating home. Browsing a descendant preserves the
existing boundary; directly attaching to a child observes that child's subtree.
