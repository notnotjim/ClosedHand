/* ============================================================
   ClosedHand Delight — Micro-interactions & Easter Eggs
   ============================================================ */

window.Delight = {
  _konamiBuffer: [],
  _logoClickTimes: [],
  _resistanceMode: false,
  _toastQueue: [],
  _seasonalCache: null,

  // -----------------------------------------------------------
  // Init
  // -----------------------------------------------------------
  init: function () {
    // Resistance mode persistence
    if (localStorage.getItem("resistance-mode") === "1") {
      document.body.classList.add("resistance-mode");
      Delight._resistanceMode = true;
    }

    // Konami code listener
    var KONAMI = [38, 38, 40, 40, 37, 39, 37, 39, 66, 65];
    document.addEventListener("keydown", function (e) {
      Delight._konamiBuffer.push(e.keyCode);
      if (Delight._konamiBuffer.length > 10) Delight._konamiBuffer.shift();
      if (JSON.stringify(Delight._konamiBuffer) === JSON.stringify(KONAMI)) {
        Delight._konamiBuffer = [];
        Delight.activateResistanceMode();
      }
    });

    // Dashboard logo click = go home
    var logo = document.getElementById("dashboard-logo");
    if (logo) {
      logo.style.cursor = "pointer";
      logo.addEventListener("click", function () {
        window.location.href = "/";
      });
    }

    // Copy feedback (delegated)
    document.addEventListener("click", function (e) {
      var copyable = e.target.closest(".activation-code, [data-copy], .mcp-url-copy");
      if (!copyable) return;
      copyable.classList.add("copy-flash");
      copyable.style.position = "relative";
      var tooltip = document.createElement("span");
      tooltip.className = "copy-tooltip";
      tooltip.textContent = "Copied!";
      copyable.appendChild(tooltip);
      setTimeout(function () {
        tooltip.remove();
        copyable.classList.remove("copy-flash");
      }, 1200);
    });

    // Connection confetti on redirect
    var params = new URLSearchParams(location.search);
    if (params.get("connected") || params.get("mcp_connected")) {
      setTimeout(function () { Delight.confetti(); }, 400);
    }

    // Override showToast for backward compatibility
    window.showToast = function (msg, isError) {
      Delight.toast(msg, isError ? "error" : "success");
    };

    // Override miniCelebration for confetti
    window.miniCelebration = function () {
      Delight.confetti();
    };

    // Ensure toast container exists
    if (!document.getElementById("toast-container")) {
      var tc = document.createElement("div");
      tc.id = "toast-container";
      document.body.appendChild(tc);
    }

    // Observe grids for stagger on content changes
    var grids = document.querySelectorAll("[data-delight-stagger]");
    grids.forEach(function (grid) {
      var observer = new MutationObserver(function () {
        Delight.staggerChildren(grid);
      });
      observer.observe(grid, { childList: true });
    });

    // Destructive action input progress
    document.addEventListener("input", function (e) {
      if (!e.target.matches(".confirm-type-input, [data-confirm-target]")) return;
      var input = e.target;
      var target = (input.placeholder || "").replace(/^Type\s+/i, "");
      if (!target) return;
      var progress = Math.min(input.value.length / Math.max(target.length, 1), 1);
      var r = Math.round(51 + (248 - 51) * progress);
      var g = Math.round(51 + (113 - 51) * progress * 0.3);
      var b = Math.round(51 + (113 - 51) * progress * 0.3);
      input.style.borderColor = "rgb(" + r + "," + g + "," + b + ")";
    });
  },

  // -----------------------------------------------------------
  // Confetti (seasonal)
  // -----------------------------------------------------------
  confetti: function (opts) {
    if (typeof window.confetti !== "function") return;
    var month = new Date().getMonth(); // 0-indexed
    var seasonal = Delight._getSeasonalConfig(month);

    // Variable reward: randomize each burst
    var angle = 55 + Math.random() * 70;
    var spread = 50 + Math.random() * 30;
    var count = 60 + Math.floor(Math.random() * 60);
    var originX = 0.3 + Math.random() * 0.4;

    var config = Object.assign({
      particleCount: count,
      angle: angle,
      spread: spread,
      origin: { x: originX, y: 0.7 },
      disableForReducedMotion: true,
    }, seasonal, opts || {});

    window.confetti(config);

    // Double burst for extra punch (slightly delayed, opposite side)
    setTimeout(function () {
      window.confetti(Object.assign({}, config, {
        particleCount: Math.floor(count * 0.6),
        angle: 180 - angle,
        origin: { x: 1 - originX, y: 0.7 },
      }));
    }, 150);
  },

  _getSeasonalConfig: function (month) {
    var day = new Date().getDate();
    // St Patrick's Day (March 17)
    if (month === 2 && day === 17) return { colors: ["#00a651", "#009944", "#4caf50", "#2e7d32", "#a5d6a7", "#fff"] };
    // Christmas (Dec 20-31)
    if (month === 11 && day >= 20) return { colors: ["#8b0000", "#cc0000", "#006400", "#228b22", "#ffd700"] };
    // New Year (Jan 1)
    if (month === 0 && day === 1) return { colors: ["#ffd700", "#ffdf00", "#fff", "#c0c0c0", "#ff6347"] };
    // Valentine's Day (Feb 14)
    if (month === 1 && day === 14) return { colors: ["#ff1744", "#e91e63", "#f48fb1", "#ff80ab", "#fff"] };
    // Halloween (Oct 31)
    if (month === 9 && day === 31) return { colors: ["#ff6600", "#ff8c00", "#1a1a1a", "#333", "#8b00ff"] };
    // 4th July
    if (month === 6 && day === 4) return { colors: ["#bf0a30", "#fff", "#002868"] };
    // Diwali (~Nov)
    if (month === 10) return { colors: ["#ff9800", "#ffd700", "#ff5722", "#e91e63", "#9c27b0"] };
    // March-May: spring blossoms
    if (month >= 2 && month <= 4) return { colors: ["#FFB7C5", "#FF69B4", "#FFC0CB", "#FFD1DC", "#FF91A4"], scalar: 1.2, shapes: ["circle"] };
    // Dec-Feb: snowflakes
    if (month === 11 || month <= 1) return { colors: ["#fff", "#b3d9ff", "#cce5ff", "#e6f2ff"], startVelocity: 15, gravity: 0.3, scalar: 1.1, shapes: ["circle"], ticks: 300 };
    // Default: party
    return { colors: ["#6ee7a8", "#60a5fa", "#f59e0b", "#ef4444", "#a78bfa", "#ec4899"] };
  },

  // -----------------------------------------------------------
  // Toast System
  // -----------------------------------------------------------
  toast: function (msg, type) {
    type = type || "success";
    var container = document.getElementById("toast-container");
    if (!container) return;

    var icons = {
      success: '<svg class="toast-icon" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="7" stroke="currentColor" stroke-width="1.5"/><path d="M5 8l2 2 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
      error: '<svg class="toast-icon" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="7" stroke="currentColor" stroke-width="1.5"/><path d="M6 6l4 4M10 6l-4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
      info: '<svg class="toast-icon" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="7" stroke="currentColor" stroke-width="1.5"/><path d="M8 7v4M8 5.5v0" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
    };

    var toast = document.createElement("div");
    toast.className = "delight-toast " + type;
    toast.innerHTML = (icons[type] || "") + '<span>' + msg + '</span>';
    container.appendChild(toast);

    // Auto-remove
    setTimeout(function () {
      toast.classList.add("delight-toast-exit");
      setTimeout(function () { toast.remove(); }, 300);
    }, 3500);
  },

  // -----------------------------------------------------------
  // Number Animation
  // -----------------------------------------------------------
  animateNumber: function (elementId, target) {
    var el = document.getElementById(elementId);
    if (!el) return;

    var targetNum = parseInt(target, 10);
    if (isNaN(targetNum) || targetNum === 0) {
      el.textContent = target;
      return;
    }

    var start = 0;
    var duration = 600;
    var startTime = null;

    function step(timestamp) {
      if (!startTime) startTime = timestamp;
      var progress = Math.min((timestamp - startTime) / duration, 1);
      // Ease-out cubic
      var eased = 1 - Math.pow(1 - progress, 3);
      el.textContent = Math.round(start + (targetNum - start) * eased);
      if (progress < 1) {
        requestAnimationFrame(step);
      } else {
        el.textContent = target; // Ensure exact value (preserves "2/5" format etc.)
      }
    }

    requestAnimationFrame(step);
  },

  // -----------------------------------------------------------
  // Stagger Children
  // -----------------------------------------------------------
  staggerChildren: function (container) {
    if (!container) return;
    var children = container.querySelectorAll(":scope > *");
    children.forEach(function (child, i) {
      child.style.setProperty("--stagger-index", i);
      child.classList.remove("delight-stagger-item");
      // Force reflow
      void child.offsetWidth;
      child.classList.add("delight-stagger-item");
    });
  },

  // -----------------------------------------------------------
  // Skeleton Loading
  // -----------------------------------------------------------
  showSkeleton: function (containerId, count, height) {
    var el = document.getElementById(containerId);
    if (!el) return;
    var html = "";
    for (var i = 0; i < count; i++) {
      html += '<div class="skeleton" style="height:' + (height || 48) + 'px;margin-bottom:6px;"></div>';
    }
    el.innerHTML = html;
  },

  // -----------------------------------------------------------
  // Resistance Mode (Konami Code)
  // -----------------------------------------------------------
  activateResistanceMode: function () {
    Delight._resistanceMode = !Delight._resistanceMode;

    if (Delight._resistanceMode) {
      document.body.classList.add("resistance-mode");
      localStorage.setItem("resistance-mode", "1");
      Delight.toast("Resistance Mode activated. Fight the machine.", "info");
      // Red/black confetti burst
      if (typeof window.confetti === "function") {
        window.confetti({
          particleCount: 100,
          spread: 70,
          colors: ["#ef4444", "#991b1b", "#1a1a1a", "#ffffff"],
          origin: { y: 0.6 },
          disableForReducedMotion: true,
        });
      }
    } else {
      document.body.classList.remove("resistance-mode");
      localStorage.removeItem("resistance-mode");
      Delight.toast("Back to normal. For now.", "info");
    }
  },

  // -----------------------------------------------------------
  // Connection milestone check
  // -----------------------------------------------------------
  checkMilestones: function (services) {
    if (!services || !Array.isArray(services)) return;
    // First non-Google service connected
    var nonGoogle = services.filter(function (s) { return s !== "google"; });
    if (nonGoogle.length === 1 && !localStorage.getItem("delight-first-extra-service")) {
      localStorage.setItem("delight-first-extra-service", "1");
      setTimeout(function () {
        Delight.confetti();
        Delight.toast("First integration connected. ClosedHand just got smarter.", "success");
      }, 500);
    }
    // Three+ services
    if (nonGoogle.length >= 3 && !localStorage.getItem("delight-power-user")) {
      localStorage.setItem("delight-power-user", "1");
      setTimeout(function () {
        Delight.confetti();
        Delight.toast("Power user unlocked. You're getting the most out of ClosedHand.", "success");
      }, 500);
    }
  },
};

// Init on DOM ready
document.addEventListener("DOMContentLoaded", function () {
  Delight.init();
});
