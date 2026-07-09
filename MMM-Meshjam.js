/* global Log, Module */

/* MagicMirror²
 * Module: MMM-Meshjam
 *
 * Now-playing + jam view for a meshjam host (github.com/Dnovak043/meshjam).
 * Card design carried over from MMM-ShairportMetadata (MIT): GPU-driven
 * progress fill, ambient glow extracted from the art, enter/leave
 * animations. New here: attribution ("via Dan's iPhone" / "added by …")
 * and an up-next queue with names — the jam view.
 *
 * Data comes from the meshjam daemon's API via node_helper, not from the
 * shairport-sync pipe (the daemon owns that pipe).
 *
 * MIT Licensed.
 */

Module.register("MMM-Meshjam", {

  defaults: {
    socketPath: "",        // default: ~/.local/share/meshjam/meshjamd.sock
    pollInterval: 1000,    // ms between daemon polls
    alignment: "center",   // left | right | center
    showAttribution: true, // "via <sender>" / "added by <name>"
    showQueue: true,       // up-next list with names (house-floor queue)
    queueLimit: 4,
    driftResyncSec: 2,     // re-arm the GPU bar only past this drift
    leaveDurationMs: 470
  },

  start: function () {
    Log.info("Starting module: " + this.name);
    this.state = { active: false };
    this.albumart = null;
    this.playing = false;
    this.stopped = true;
    this.trackKey = "";
    this.baseSec = 0;
    this.anchor = this.now();
    this.songLenSec = 0;
    this.glowColor = "rgba(140,80,200,0.28)";

    this.cardEl = null;
    this.artWrap = null;
    this.artImg = null;
    this.refs = {};
    this.visible = false;
    this.appearing = false;
    this.leaving = false;
    this.leaveTimer = null;

    this.sendSocketNotification("CONFIG", this.config);
    setInterval(() => { this.tick(); }, 1000);
  },

  now: function () { return new Date().getTime() / 1000; },

  elapsedNow: function () {
    var e = this.playing ? this.baseSec + (this.now() - this.anchor) : this.baseSec;
    if (e < 0) { e = 0; }
    if (this.songLenSec > 0 && e > this.songLenSec) { e = this.songLenSec; }
    return e;
  },

  secToTime: function (sec) {
    sec = Math.max(0, Math.floor(sec));
    var min = Math.floor(sec / 60);
    var remain = sec % 60;
    return min + ":" + (remain < 10 ? "0" : "") + remain;
  },

  getHeader: function () { return ""; },

  socketNotificationReceived: function (notification, payload) {
    if (notification === "MESHJAM_ARTWORK") {
      this.albumart = payload.dataUrl || null;
      if (this.albumart) { this.extractGlow(this.albumart); }
      else { this.setGlow("rgba(140,80,200,0.28)"); }
      if (this.visible && this.artImg) { this.applyArt(); }
      return;
    }
    if (notification !== "MESHJAM_STATE") { return; }

    if (!payload.active) {
      this.state = payload;
      if (this.visible) { this.beginLeave(); }
      return;
    }
    if (this.leaving) { this.cancelLeave(); }
    this.stopped = false;

    var key = payload.title + "|" + payload.artist;
    var trackChanged = key !== this.trackKey;
    var playChanged = payload.playing !== this.playing;
    this.trackKey = key;
    this.state = payload;
    this.playing = payload.playing;

    // Anchor progress from the daemon-reported position; only re-arm the
    // GPU bar on track change, play/pause, or real drift — never per poll.
    var reportedSec = (payload.positionMs || 0) / 1000;
    var drift = Math.abs(this.elapsedNow() - reportedSec);
    var needSync = trackChanged || playChanged ||
      drift > (this.config.driftResyncSec || 2);
    if (needSync) {
      this.baseSec = reportedSec;
      this.anchor = this.now();
      this.songLenSec = (payload.durationMs || 0) / 1000;
    }
    if (trackChanged) { this.albumart = null; }

    if (!this.visible) {
      this.appearing = true;
      this.updateDom(0);
    } else {
      this.updateCardContent(needSync);
    }
  },

  beginLeave: function () {
    if (!this.visible || !this.cardEl) {
      this.stopped = true; this.playing = false; this.updateDom(0); return;
    }
    if (this.leaving) { return; }
    this.leaving = true;
    this.cardEl.classList.remove("anim-in");
    this.cardEl.classList.add("anim-out");
    var self = this;
    this.leaveTimer = setTimeout(function () {
      self.leaving = false; self.leaveTimer = null;
      self.stopped = true; self.playing = false;
      self.updateDom(0);
    }, this.config.leaveDurationMs);
  },

  cancelLeave: function () {
    this.leaving = false;
    if (this.leaveTimer) { clearTimeout(this.leaveTimer); this.leaveTimer = null; }
    if (this.cardEl) { this.cardEl.classList.remove("anim-out"); }
  },

  tick: function () {
    if (!this.visible || this.leaving || this.stopped) { return; }
    this.renderLabels();
  },

  renderLabels: function () {
    if (!this.refs.elapsedSpan) { return; }
    var total = this.songLenSec;
    var elapsed = this.elapsedNow();
    this.refs.elapsedSpan.textContent = this.secToTime(elapsed);
    if (!this.playing) {
      this.refs.rightSpan.className = "paused-badge";
      this.refs.rightSpan.textContent = "paused";
    } else if (total > 0) {
      this.refs.rightSpan.className = "";
      this.refs.rightSpan.textContent = "-" + this.secToTime(Math.max(0, total - elapsed));
    } else {
      this.refs.rightSpan.className = "";
      this.refs.rightSpan.textContent = "";
    }
  },

  // One compositor transition from current position to the end over the
  // remaining duration — no per-frame JS (from MMM-ShairportMetadata).
  syncBar: function () {
    var fill = this.refs.fillEl;
    if (!fill) { return; }
    if (this.songLenSec <= 0) {  // radio/live: keep the bar empty
      fill.style.transition = "none";
      fill.style.transform = "scaleX(0)";
      return;
    }
    var total = this.songLenSec;
    var elapsed = this.elapsedNow();
    var f = Math.max(0, Math.min(1, elapsed / total));

    fill.style.transition = "none";
    fill.style.transform = "scaleX(" + f + ")";
    void fill.offsetWidth;  // commit the frozen state

    if (this.playing) {
      var remaining = Math.max(0, total - elapsed);
      var self = this;
      requestAnimationFrame(function () {
        requestAnimationFrame(function () {
          if (!self.playing || !self.refs.fillEl) { return; }
          self.refs.fillEl.style.transition = "transform " + remaining + "s linear";
          self.refs.fillEl.style.transform = "scaleX(1)";
        });
      });
    }
  },

  applyArt: function () {
    if (this.albumart) {
      this.artImg.src = this.albumart;
      this.artImg.style.display = "";
      this.artWrap.classList.remove("no-art");
    } else {
      this.artImg.removeAttribute("src");
      this.artImg.style.display = "none";
      this.artWrap.classList.add("no-art");
    }
  },

  attributionText: function () {
    if (!this.config.showAttribution) { return ""; }
    if (this.state.airplay && this.state.sender) { return "via " + this.state.sender; }
    if (this.state.addedBy && this.state.addedBy !== "cli") {
      return "added by " + this.state.addedBy;
    }
    return "";
  },

  updateCardContent: function (needSync) {
    if (!this.cardEl) { return; }
    this.refs.titleEl.textContent = this.state.title || "";
    this.refs.artistEl.textContent = this.state.artist || "";
    var album = this.state.album || "";
    this.refs.albumEl.textContent = album;
    this.refs.albumEl.style.display = album ? "" : "none";
    this.applyArt();
    this.setGlow(this.glowColor);

    var who = this.attributionText();
    this.refs.clientEl.textContent = who;
    this.refs.clientEl.style.display = who ? "" : "none";

    this.renderQueue();
    this.renderLabels();
    if (needSync !== false) { this.syncBar(); }
  },

  renderQueue: function () {
    var box = this.refs.queueEl;
    if (!box) { return; }
    var items = (this.config.showQueue && this.state.queue) ? this.state.queue : [];
    items = items.slice(0, this.config.queueLimit);
    if (items.length === 0) {
      box.style.display = "none";
      box.innerHTML = "";
      return;
    }
    box.style.display = "";
    box.innerHTML = "";
    var head = document.createElement("div");
    head.className = "queue-head";
    head.textContent = "Up next";
    box.appendChild(head);
    items.forEach(function (item) {
      var row = document.createElement("div");
      row.className = "queue-row";
      var t = document.createElement("span");
      t.className = "queue-title";
      t.textContent = item.title + (item.artist ? " — " + item.artist : "");
      row.appendChild(t);
      if (item.addedBy && item.addedBy !== "cli") {
        var w = document.createElement("span");
        w.className = "queue-who";
        w.textContent = item.addedBy;
        row.appendChild(w);
      }
      box.appendChild(row);
    });
  },

  setGlow: function (c) {
    this.glowColor = c;
    if (this.cardEl) { this.cardEl.style.setProperty("--art-glow", c); }
  },

  extractGlow: function (dataUrl) {
    var self = this;
    var img = new Image();
    img.onload = function () {
      try {
        var canvas = document.createElement("canvas");
        canvas.width = 16; canvas.height = 16;
        var ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, 16, 16);
        var d = ctx.getImageData(0, 0, 16, 16).data;
        var r = 0, g = 0, b = 0, count = 0;
        for (var i = 0; i < d.length; i += 4) {
          var brightness = (d[i] + d[i + 1] + d[i + 2]) / 3;
          var max = Math.max(d[i], d[i + 1], d[i + 2]);
          var sat = max > 0 ? (max - Math.min(d[i], d[i + 1], d[i + 2])) / max : 0;
          if (brightness > 20 && sat > 0.15) { r += d[i]; g += d[i + 1]; b += d[i + 2]; count++; }
        }
        if (count > 0) {
          r = Math.round(r / count); g = Math.round(g / count); b = Math.round(b / count);
          self.setGlow("rgba(" + r + "," + g + "," + b + ",0.35)");
        } else {
          self.setGlow("rgba(140,80,200,0.28)");
        }
      } catch (e) { /* tainted canvas — ignore */ }
    };
    img.src = dataUrl;
  },

  getDom: function () {
    var wrapper = document.createElement("div");
    wrapper.style.textAlign =
      this.config.alignment === "left" ? "left"
        : this.config.alignment === "right" ? "right" : "center";

    if (this.stopped && !this.leaving) {
      this.cardEl = null; this.artWrap = null; this.artImg = null;
      this.refs = {}; this.visible = false;
      wrapper.style.display = "none";
      return wrapper;
    }

    var card = document.createElement("div");
    card.className = "airplay-card";
    card.style.display = "inline-flex";

    var artWrap = document.createElement("div");
    artWrap.className = "albumart-wrap";
    var img = document.createElement("img");
    artWrap.appendChild(img);
    card.appendChild(artWrap);

    var info = document.createElement("div");
    info.className = "track-info";
    var titleEl = document.createElement("div"); titleEl.className = "track-title";
    var artistEl = document.createElement("div"); artistEl.className = "track-artist";
    var albumEl = document.createElement("div"); albumEl.className = "track-album";
    info.appendChild(titleEl); info.appendChild(artistEl); info.appendChild(albumEl);
    card.appendChild(info);

    var progWrap = document.createElement("div"); progWrap.className = "progress-wrap";
    var track = document.createElement("div"); track.className = "progress-track";
    var fillEl = document.createElement("div"); fillEl.className = "progress-fill";
    track.appendChild(fillEl);
    progWrap.appendChild(track);
    card.appendChild(progWrap);

    var times = document.createElement("div"); times.className = "progress-times";
    var elapsedSpan = document.createElement("span");
    var rightSpan = document.createElement("span");
    times.appendChild(elapsedSpan); times.appendChild(rightSpan);
    card.appendChild(times);

    var clientEl = document.createElement("div"); clientEl.className = "client-line";
    card.appendChild(clientEl);

    var queueEl = document.createElement("div"); queueEl.className = "jam-queue";
    card.appendChild(queueEl);

    this.cardEl = card;
    this.artWrap = artWrap;
    this.artImg = img;
    this.refs = { titleEl, artistEl, albumEl, fillEl, elapsedSpan, rightSpan, clientEl, queueEl };

    this.updateCardContent();

    if (this.appearing) { card.classList.add("anim-in"); this.appearing = false; }

    this.visible = true;
    wrapper.appendChild(card);
    return wrapper;
  },

  getStyles: function () {
    return ["MMM-Meshjam.css"];
  }

});
