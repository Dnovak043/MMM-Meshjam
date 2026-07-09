/* MagicMirror²
 * Module: MMM-Meshjam — node_helper
 *
 * Client of the meshjam daemon's unix-socket API (JSON lines).
 * Polls `status`; fetches `artwork` only when the artwork id changes.
 *
 * Unlike MMM-ShairportMetadata this does NOT read the shairport-sync
 * metadata pipe: meshjamd owns that pipe (two readers on one FIFO steal
 * items from each other). Everything comes through the daemon.
 *
 * MIT Licensed.
 */

const NodeHelper = require("node_helper");
const net = require("net");
const os = require("os");
const path = require("path");

module.exports = NodeHelper.create({

  start: function () {
    this.timer = null;
    this.lastArtworkId = null;
    this.daemonWasUp = true; // log daemon-down only on transitions
  },

  socketNotificationReceived: function (notification, payload) {
    if (notification !== "CONFIG") { return; }
    this.config = payload;
    this.socketPath = payload.socketPath ||
      path.join(os.homedir(), ".local", "share", "meshjam", "meshjamd.sock");
    if (this.timer) { clearInterval(this.timer); }
    const interval = Math.max(300, payload.pollInterval || 1000);
    this.timer = setInterval(() => this.poll(), interval);
    this.poll();
  },

  // One request per short-lived connection: stateless and cheap on a
  // local unix socket.
  call: function (op, args) {
    return new Promise((resolve, reject) => {
      const sock = net.createConnection(this.socketPath);
      let buf = "";
      sock.setTimeout(3000, () => { sock.destroy(); reject(new Error("timeout")); });
      sock.on("error", reject);
      sock.on("connect", () => {
        sock.write(JSON.stringify({ op: op, args: args || {} }) + "\n");
      });
      sock.on("data", (chunk) => {
        buf += chunk.toString();
        const nl = buf.indexOf("\n");
        if (nl === -1) { return; }
        sock.end();
        try {
          const msg = JSON.parse(buf.slice(0, nl));
          if (!msg.ok) { reject(new Error(msg.error || "daemon error")); }
          else { resolve(msg.result); }
        } catch (e) { reject(e); }
      });
    });
  },

  poll: async function () {
    let status;
    try {
      status = await this.call("status");
      if (!this.daemonWasUp) {
        console.log("[MMM-Meshjam] meshjamd is back");
        this.daemonWasUp = true;
      }
    } catch (e) {
      if (this.daemonWasUp) {
        console.log("[MMM-Meshjam] meshjamd unreachable at " + this.socketPath +
          " (" + e.message + ")");
        this.daemonWasUp = false;
      }
      this.sendSocketNotification("MESHJAM_STATE", { active: false });
      return;
    }
    this.sendSocketNotification("MESHJAM_STATE", this.shape(status));
    await this.maybeFetchArtwork(status);
  },

  shape: function (status) {
    const pb = status.playback || {};
    const ap = status.airplay || {};
    const cur = status.current;
    const ref = cur ? cur.ref : null;
    const airplayLive = pb.source === "airplay-passthrough";
    const active = !!ref && (pb.state === "playing" || pb.state === "paused");
    return {
      active: active,
      playing: pb.state === "playing",
      title: ref ? (ref.title || ref.uri) : "",
      artist: ref ? ref.artist : "",
      album: ref ? ref.album : "",
      sender: airplayLive ? (ap.sender || "") : "",
      addedBy: cur ? (cur.added_by || "") : "",
      airplay: airplayLive,
      positionMs: pb.position_ms || 0,
      durationMs: (airplayLive && ap.duration_ms) ? ap.duration_ms
        : (ref ? (ref.duration_ms || 0) : 0),
      artworkId: ap.artwork_id || "",
      queue: (status.queue || []).map(function (item) {
        return {
          title: item.ref.title || item.ref.uri,
          artist: item.ref.artist || "",
          addedBy: item.added_by || "",
          kind: item.ref.kind
        };
      })
    };
  },

  maybeFetchArtwork: async function (status) {
    const id = (status.airplay && status.airplay.artwork_id) || "";
    if (id === this.lastArtworkId) { return; }
    if (!id) {
      this.lastArtworkId = "";
      this.sendSocketNotification("MESHJAM_ARTWORK", { id: "", dataUrl: null });
      return;
    }
    try {
      const art = await this.call("artwork");
      if (art && art.b64) {
        this.lastArtworkId = art.id;
        this.sendSocketNotification("MESHJAM_ARTWORK", {
          id: art.id,
          dataUrl: "data:" + (art.mime || "image/jpeg") + ";base64," + art.b64
        });
      }
    } catch (e) { /* art is decorative; next poll retries */ }
  }

});
