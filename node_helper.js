/* MagicMirror²
 * Module: MMM-Meshjam — node_helper
 *
 * Client for the meshjam daemon's Unix-socket JSON-lines API.
 * Polls `status` and fetches `artwork` only when the artwork ID changes.
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
    this.pollInFlight = false;
    this.lastArtworkId = null;
    this.daemonWasUp = true;
    this.config = {};

    this.socketPath = path.join(
      os.homedir(),
      ".local",
      "share",
      "meshjam",
      "meshjamd.sock"
    );
  },

  stop: function () {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  },

  socketNotificationReceived: function (notification, payload) {
    if (notification !== "CONFIG") {
      return;
    }

    this.config = payload || {};

    this.socketPath =
      this.config.socketPath ||
      path.join(
        os.homedir(),
        ".local",
        "share",
        "meshjam",
        "meshjamd.sock"
      );

    if (this.timer) {
      clearInterval(this.timer);
    }

    const interval = Math.max(
      300,
      Number(this.config.pollInterval) || 1000
    );

    this.timer = setInterval(() => {
      this.poll();
    }, interval);

    this.poll();
  },

  call: function (op, args) {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(this.socketPath);
      let buffer = "";
      let settled = false;

      const finish = (error, result) => {
        if (settled) {
          return;
        }

        settled = true;
        socket.removeAllListeners();
        socket.destroy();

        if (error) {
          reject(error);
        } else {
          resolve(result);
        }
      };

      socket.setTimeout(3000);

      socket.on("timeout", () => {
        finish(new Error("timeout"));
      });

      socket.on("error", (error) => {
        finish(error);
      });

      socket.on("connect", () => {
        socket.write(
          JSON.stringify({
            op: op,
            args: args || {}
          }) + "\n"
        );
      });

      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");

        const newlineIndex = buffer.indexOf("\n");

        if (newlineIndex === -1) {
          return;
        }

        try {
          const message = JSON.parse(
            buffer.slice(0, newlineIndex)
          );

          if (!message.ok) {
            finish(
              new Error(message.error || "daemon error")
            );
            return;
          }

          finish(null, message.result);
        } catch (error) {
          finish(error);
        }
      });

      socket.on("end", () => {
        if (!settled && buffer.trim()) {
          try {
            const message = JSON.parse(buffer.trim());

            if (!message.ok) {
              finish(
                new Error(message.error || "daemon error")
              );
              return;
            }

            finish(null, message.result);
          } catch (error) {
            finish(error);
          }
        } else if (!settled) {
          finish(
            new Error(
              "daemon closed connection without a response"
            )
          );
        }
      });
    });
  },

  poll: async function () {
    if (this.pollInFlight) {
      return;
    }

    this.pollInFlight = true;

    try {
      const status = await this.call("status");

      if (!this.daemonWasUp) {
        console.log("[MMM-Meshjam] meshjamd is back");
        this.daemonWasUp = true;
      }

      const shapedStatus = this.shape(status || {});

      this.sendSocketNotification(
        "MESHJAM_STATE",
        shapedStatus
      );

      await this.maybeFetchArtwork(
        status || {},
        shapedStatus.artworkId
      );
    } catch (error) {
      if (this.daemonWasUp) {
        console.log(
          "[MMM-Meshjam] meshjamd unreachable at " +
            this.socketPath +
            " (" +
            error.message +
            ")"
        );

        this.daemonWasUp = false;
      }

      this.sendSocketNotification("MESHJAM_STATE", {
        active: false,
        playing: false,
        title: "",
        artist: "",
        album: "",
        sender: "",
        addedBy: "",
        airplay: false,
        positionMs: 0,
        durationMs: 0,
        artworkId: "",
        queue: [],
        history: [],
        queueIndex: 0,
        queueCount: 0
      });
    } finally {
      this.pollInFlight = false;
    }
  },

  firstString: function () {
    for (
      let index = 0;
      index < arguments.length;
      index += 1
    ) {
      const value = arguments[index];

      if (
        typeof value === "string" &&
        value.trim()
      ) {
        return value.trim();
      }
    }

    return "";
  },

  firstNumber: function () {
    for (
      let index = 0;
      index < arguments.length;
      index += 1
    ) {
      const value = Number(arguments[index]);

      if (
        Number.isFinite(value) &&
        value >= 0
      ) {
        return value;
      }
    }

    return 0;
  },

  getAirplayMetadata: function (status) {
    const airplay = status.airplay || {};

    return (
      airplay.metadata ||
      airplay.now_playing ||
      airplay.nowPlaying ||
      status.airplay_metadata ||
      {}
    );
  },

  shape: function (status) {
    const playback = status.playback || {};
    const airplay = status.airplay || {};
    const airplayMetadata =
      this.getAirplayMetadata(status);

    const current = status.current || {};
    const reference = current.ref || {};

    const airplayLive =
      playback.source === "airplay-passthrough";

    /*
     * Live AirPlay may be playing or paused without
     * status.current.ref being populated.
     */
    const active =
      playback.state === "playing" ||
      playback.state === "paused";

    const title = this.firstString(
      reference.title,
      airplayMetadata.title,
      airplay.title,
      reference.uri
    );

    const artist = this.firstString(
      reference.artist,
      airplayMetadata.artist,
      airplay.artist
    );

    const album = this.firstString(
      reference.album,
      airplayMetadata.album,
      airplay.album
    );

    const artworkId = this.firstString(
      airplay.artwork_id,
      airplayMetadata.artwork_id,
      reference.artwork_id
    );

    const rowFromItem = (item) => {
      const rowItem = item || {};
      const rowReference = rowItem.ref || {};

      return {
        title: this.firstString(
          rowReference.title,
          rowReference.uri
        ),

        artist: this.firstString(
          rowReference.artist
        ),

        addedBy: this.firstString(
          rowItem.added_by
        ),

        kind: this.firstString(
          rowReference.kind
        )
      };
    };

    const queue = Array.isArray(status.queue)
      ? status.queue.map(rowFromItem)
      : [];

    /*
     * Apple's jam up-next never reaches an AirPlay receiver; history
     * (newest first) feeds the frontend's "Recently played" fallback.
     */
    const history = Array.isArray(status.history)
      ? status.history.slice().reverse().map(rowFromItem)
      : [];

    return {
      active: active,
      playing: playback.state === "playing",

      title: title,
      artist: artist,
      album: album,

      sender: airplayLive
        ? this.firstString(
            airplay.sender,
            airplay.client,
            airplay.device_name,
            airplay.deviceName
          )
        : "",

      addedBy: this.firstString(
        current.added_by
      ),

      airplay: airplayLive,

      positionMs: this.firstNumber(
        playback.position_ms,
        airplay.position_ms,
        airplayMetadata.position_ms
      ),

      durationMs: this.firstNumber(
        airplayLive
          ? airplay.duration_ms
          : undefined,

        airplayLive
          ? airplayMetadata.duration_ms
          : undefined,

        reference.duration_ms
      ),

      artworkId: artworkId,
      queue: queue,
      history: history,

      /*
       * Sender-pushed queue position ("track N of M"). The daemon
       * reports index 0-based, or -1 when unknown; queue contents
       * themselves are pull-only in the protocol and never sent.
       */
      queueIndex: this.firstNumber(
        airplay.queue_index >= 0
          ? airplay.queue_index
          : undefined
      ),

      queueCount:
        Number(airplay.queue_count) > 0
          ? Number(airplay.queue_count)
          : 0
    };
  },

  normalizeMime: function (mime) {
    const value = this.firstString(
      mime
    ).toLowerCase();

    if (!value) {
      return "image/jpeg";
    }

    if (value.startsWith("image/")) {
      return value;
    }

    if (
      value === "jpg" ||
      value === "jpeg"
    ) {
      return "image/jpeg";
    }

    if (value === "png") {
      return "image/png";
    }

    if (value === "webp") {
      return "image/webp";
    }

    if (value === "gif") {
      return "image/gif";
    }

    return "image/jpeg";
  },

  maybeFetchArtwork: async function (
    status,
    shapedArtworkId
  ) {
    const airplay = status.airplay || {};
    const airplayMetadata =
      this.getAirplayMetadata(status);

    const requestedId = this.firstString(
      shapedArtworkId,
      airplay.artwork_id,
      airplayMetadata.artwork_id
    );

    if (requestedId === this.lastArtworkId) {
      return;
    }

    if (!requestedId) {
      this.lastArtworkId = "";

      this.sendSocketNotification(
        "MESHJAM_ARTWORK",
        {
          id: "",
          dataUrl: null
        }
      );

      return;
    }

    try {
      const artwork = await this.call(
        "artwork"
      );

      if (!artwork || !artwork.b64) {
        throw new Error(
          "daemon returned no artwork data"
        );
      }

      const returnedId = this.firstString(
        artwork.id,
        requestedId
      );

      /*
       * Ignore stale artwork if the song changed while
       * the artwork request was in progress.
       */
      if (
        artwork.id &&
        returnedId !== requestedId
      ) {
        return;
      }

      const rawArtwork = String(
        artwork.b64
      ).trim();

      const dataUrl = rawArtwork.startsWith(
        "data:"
      )
        ? rawArtwork
        : "data:" +
          this.normalizeMime(
            artwork.mime ||
              artwork.content_type
          ) +
          ";base64," +
          rawArtwork.replace(/\s+/g, "");

      this.lastArtworkId = requestedId;

      this.sendSocketNotification(
        "MESHJAM_ARTWORK",
        {
          id: requestedId,
          dataUrl: dataUrl
        }
      );
    } catch (error) {
      console.error(
        "[MMM-Meshjam] artwork fetch failed for " +
          requestedId +
          ": " +
          error.message
      );
    }
  }
});
