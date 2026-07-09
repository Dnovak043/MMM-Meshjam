# MMM-Meshjam

A [MagicMirror²](https://github.com/MichMich/MagicMirror) now-playing +
**jam view** for a [meshjam](https://github.com/Dnovak043/meshjam) host —
the Raspberry Pi AirPlay receiver that hosts native Apple Music jams
(no FaceTime, no subscriptions on the Pi) over call-proof buffered
AirPlay 2.

Successor to
[MMM-ShairportMetadata](https://github.com/Dnovak043/MMM-ShairportMetadata):
same Apple-Music-style card (album art with ambient glow, GPU-smooth
progress bar, enter/leave animations), plus what meshjam knows that a raw
metadata pipe doesn't:

- **Attribution** — *"via Dan's iPhone"* for the live AirPlay sender, or
  *"added by …"* for house-floor items
- **Up next** — the queue with each track's contributor
- Works for both AirPlay sessions and meshjam's house floor (files/radio)

## How it connects (and why it replaces the old module)

This module is a **client of the meshjam daemon's API** (unix socket).
It does **not** read the shairport-sync metadata pipe: `meshjamd` owns
that pipe, and two readers on one FIFO silently steal items from each
other. If you previously ran MMM-ShairportMetadata against the same pipe,
remove it when enabling this module — MMM-Meshjam shows everything it
showed, sourced through the daemon.

Requirements: meshjamd running **on the same machine** as MagicMirror
(both on the Pi), meshjam at commit with the `artwork` API op (2026-07-08
or later).

## Install

```sh
cd ~/MagicMirror/modules
git clone https://github.com/Dnovak043/MMM-Meshjam
```

No npm install needed (Node stdlib only).

## Configure

Add to `config/config.js`:

```javascript
{
  module: "MMM-Meshjam",
  position: "bottom_left",
  config: {
    // socketPath: "/home/davidnovak043/.local/share/meshjam/meshjamd.sock",
    // ^ default is ~/.local/share/meshjam/meshjamd.sock for the user
    //   running MagicMirror — set explicitly if meshjamd runs as a
    //   different user or with a custom data_dir/socket.
    alignment: "center",     // left | right | center
    showAttribution: true,
    showQueue: true,         // up-next list (house-floor queue) with names
    queueLimit: 4,
    pollInterval: 1000       // ms
  }
},
```

## Options

| Option | Default | Description |
|---|---|---|
| `socketPath` | `~/.local/share/meshjam/meshjamd.sock` | meshjamd API socket |
| `pollInterval` | `1000` | ms between status polls (min 300) |
| `alignment` | `center` | card alignment in its region |
| `showAttribution` | `true` | sender / added-by line under the card |
| `showQueue` | `true` | up-next list with contributor chips |
| `queueLimit` | `4` | max queue rows |
| `driftResyncSec` | `2` | re-arm the progress bar only past this drift |
| `hide` | — | card hides automatically when nothing is playing |

## Troubleshooting

- **Card never appears:** is meshjamd up? `meshjam status` in a shell.
  Check the MagicMirror log for `[MMM-Meshjam] meshjamd unreachable` —
  usually a `socketPath` mismatch (different user or custom `data_dir`).
- **No album art:** art arrives only for AirPlay senders that transmit
  it (Apple Music does). meshjam must include the artwork op —
  `meshjam status` failing on older builds means `git pull` + reinstall.
- **Both this and MMM-ShairportMetadata configured:** remove the old one;
  see "How it connects" above.

## License

MIT — card design and rendering approach from MMM-ShairportMetadata
(Prateek Sureka, ChielChiel), adapted with attribution.
