# Driver app: GPS over socket.io

This explains how the driver app sends phone GPS to `loadsmart-tracking`. While the driver is on a trip, the app sends one location every 15 seconds over a persistent socket.io connection.

## Connect

```ts
import { io } from 'socket.io-client';

const socket = io(`${TRACKING_URL}/driver`, {
  transports: ['websocket'], // required — long-polling is not served
  // A callback, not a static object: it runs on every (re)connect, so an expired token is
  // replaced by a fresh one from the app's normal refresh flow.
  auth: async (cb) => cb({ token: await getDriverAccessToken() }),
  reconnection: true,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 30000,
});
```

- **Token:** use the same driver access token the app already gets from the main loadsmart backend (`purpose: driver-access`, with a tenant selected). Tracking verifies it with the shared secret and checks it hasn't been revoked.
- **Handshake errors:** a failed handshake raises `connect_error` with the message `unauthorized`. Refresh the token and try again; if that still fails, the driver has to log in again.
- **Token expiry:** when the access token expires, the server emits `auth:expired` and then disconnects. socket.io reconnects automatically and calls `auth` again, which fetches a fresh token.

## Send locations

There are two events. **Both require an ack callback**, and an event sent without one is ignored.

| Event       | Payload               | When                                                                    |
| ----------- | --------------------- | ----------------------------------------------------------------------- |
| `loc`       | One point             | Every 15 s while online. The server rejects more than one `loc` per 4 s |
| `loc:batch` | Array of 1–200 points | On reconnect, to flush the offline queue. At most one batch per second  |

```ts
const ack = await socket.timeout(10_000).emitWithAck('loc', point);
// { ok: true, accepted: 1, noTrip: 0 }
// { ok: false, error: 'invalid_payload' | 'rate_limited' | 'unavailable' }
```

### Point

| Field        | Type                                           | Notes                                                                                |
| ------------ | ---------------------------------------------- | ------------------------------------------------------------------------------------ |
| `pointId`    | string, optional                               | Client-generated, UUIDv7 recommended. Used for tracing                               |
| `lat`, `lng` | number                                         | WGS84                                                                                |
| `accuracy`   | number, optional                               | Horizontal accuracy in **metres**. Fixes worse than 50 m are dropped                 |
| `speed`      | number, optional                               | **m/s**, exactly as the OS reports it                                                |
| `bearing`    | number, optional                               | Degrees, 0–360                                                                       |
| `altitude`   | number, optional                               | Metres                                                                               |
| `recordedAt` | string                                         | ISO-8601 with an offset. This is the **fix time**, not the send time                 |
| `isMock`     | boolean                                        | Android `Location.isMock()`. Mock fixes are dropped, and the trip is flagged for ops |
| `batteryPct` | number, optional                               | 0–100                                                                                |
| `provider`   | `gps`, `network`, `fused` or `other`, optional |                                                                                      |
| `appState`   | `foreground` or `background`, optional         |                                                                                      |

### Ack

| Ack                | Meaning                                                                                                                                                   | What the app should do                                                  |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `ok: true`         | Points are durably queued. `noTrip` counts points that belong to no trip of the driver's: before the trip started, after it ended, or with no trip at all | Delete **all** sent points from the local queue                         |
| `rate_limited`     | Sent too often                                                                                                                                            | Keep the points and send them in the next batch                         |
| `invalid_payload`  | The payload failed validation                                                                                                                             | Log it and drop it. Retrying won't help                                 |
| `unavailable`      | A temporary server problem                                                                                                                                | Keep the points and retry later                                         |
| No ack within 10 s | The network dropped                                                                                                                                       | Keep the points. They go out in the next `loc:batch` after reconnecting |

## Offline queue (required)

1. Every fix goes into a local persistent queue (SQLite) **before** it is sent.
2. Delete points only after an `ok: true` ack.
3. On reconnect, flush the queue oldest-first in `loc:batch` chunks of 200 or fewer, one chunk per second.
4. Resending a point the server already has is harmless: duplicates are dropped by vehicle, source and `recordedAt`.

Offline batches may be flushed after the trip has ended. Points recorded during the trip still land on that trip.

## Location collection (Android)

- Use the fused location provider in a **foreground service** with a persistent notification. Request a 15 s interval at `PRIORITY_HIGH_ACCURACY`.
- Ask the driver to exempt the app from battery optimization. Without that, the OS kills background location on most Indian OEM phones.
- Only collect during an active trip. Points sent outside a trip come back as `noTrip` and aren't stored.
