function initAmbientBackground() {
  var container = document.getElementById("ambient-bg");
  if (!container) return;

  var spectrumColors = [
    { h: 280, s: 60, l: 35 },
    { h: 220, s: 55, l: 30 },
    { h: 340, s: 50, l: 35 },
    { h: 180, s: 45, l: 28 }
  ];

  var cloudBlobs = [
    { id: 1, baseX: 20, baseY: 30, baseSize: 450, colorIndex: 0, speed: 0.3, depth: "background" },
    { id: 2, baseX: 70, baseY: 20, baseSize: 380, colorIndex: 1, speed: 0.35, depth: "midground" },
    { id: 3, baseX: 15, baseY: 75, baseSize: 420, colorIndex: 2, speed: 0.28, depth: "background" },
    { id: 4, baseX: 80, baseY: 65, baseSize: 350, colorIndex: 3, speed: 0.4, depth: "midground" }
  ];

  var stars = [];
  for (var i = 0; i < 35; i++) {
    stars.push({
      id: "star-" + i, type: "star",
      x: (i * 17 + 5) % 100, y: (i * 23 + 10) % 100,
      size: 1.5 + (i % 4) * 0.5,
      baseOpacity: 0.4 + (i % 3) * 0.2,
      twinkleSpeed: 0.1 + (i % 5) * 0.05,
      hue: 200 + (i % 6) * 10
    });
  }

  var planets = [];
  var px = [15, 85, 25], py = [20, 30, 70];
  for (var i = 0; i < 3; i++) {
    planets.push({
      id: "planet-" + i, type: "planet",
      x: px[i], y: py[i],
      size: 20 + i * 5,
      baseOpacity: 0.5 + i * 0.1,
      driftSpeed: 0.3 + i * 0.15,
      hue: 220 + i * 15,
      driftDirection: (i * Math.PI) / 2
    });
  }

  var galaxies = [];
  for (var i = 0; i < 3; i++) {
    galaxies.push({
      id: "galaxy-" + i, type: "galaxy",
      x: i === 0 ? 20 : i === 1 ? 80 : 75,
      y: i === 0 ? 25 : i === 1 ? 75 : 80,
      size: i === 2 ? 37 : i === 1 ? 20 : 35,
      baseOpacity: 0.25 + i * 0.15,
      rotationSpeed: 0.02 + i * 0.01,
      hue: 260 + i * 20
    });
  }

  var celestialElements = stars.concat(planets, galaxies);

  // Create DOM elements
  var celestialDivs = [];
  for (var i = 0; i < celestialElements.length; i++) {
    var el = celestialElements[i];
    var div = document.createElement("div");
    div.style.cssText = "position:absolute;will-change:opacity,transform;";
    div.style.left = el.x + "%";
    div.style.top = el.y + "%";
    div.style.width = el.size + "px";
    div.style.height = el.size + "px";

    if (el.type === "star") {
      div.style.background = "radial-gradient(circle, hsl(" + el.hue + ",80%,90%) 0%, hsl(" + el.hue + ",60%,70%) 50%, transparent 100%)";
      div.style.borderRadius = "50%";
    } else if (el.type === "planet") {
      var pid = parseInt(el.id.slice(-1));
      if (pid === 0) {
        div.style.background = "radial-gradient(circle, #4A90E2 0%, #2E7D32 40%, #1565C0 80%, transparent 100%)";
        div.style.borderRadius = "47% 53% 52% 48%";
      } else if (pid === 1) {
        div.style.background = "radial-gradient(circle, #FF6B35 0%, #D84315 40%, #BF360C 80%, transparent 100%)";
        div.style.borderRadius = "45% 55% 50% 50%";
      } else {
        div.style.background = "radial-gradient(circle, #9C27B0 0%, #673AB7 40%, #3F51B5 80%, transparent 100%)";
        div.style.borderRadius = "49% 51% 48% 52%";
      }
    } else if (el.type === "galaxy") {
      if (el.id === "galaxy-2") {
        div.style.background = "radial-gradient(ellipse at 30% 40%, hsl(280,70%,50%) 0%, hsl(260,65%,40%) 15%, hsl(240,60%,35%) 30%, hsla(220,55%,25%,0.8) 45%, hsla(200,50%,15%,0.4) 60%, transparent 75%)";
        div.style.borderRadius = "35% 65% 45% 55% / 60% 40% 70% 30%";
      } else {
        div.style.background = "radial-gradient(ellipse, hsl(" + el.hue + ",70%,40%) 0%, hsl(" + (el.hue + 30) + ",60%,30%) 40%, hsl(" + el.hue + ",50%,20%) 70%, transparent 100%)";
        div.style.borderRadius = "40% 60% 30% 70%";
      }
    }

    container.appendChild(div);
    celestialDivs.push(div);
  }

  var blobDivs = [];
  for (var i = 0; i < cloudBlobs.length; i++) {
    var div = document.createElement("div");
    div.style.cssText = "position:absolute;will-change:transform,border-radius,opacity;mix-blend-mode:screen;";
    container.appendChild(div);
    blobDivs.push(div);
  }

  function getBlobPosition(blob, time) {
    var baseTime = time * 0.0005;
    var floatX = Math.sin(baseTime * blob.speed) * 15 + Math.cos(baseTime * blob.speed * 0.3) * 10;
    var floatY = Math.cos(baseTime * blob.speed * 0.7) * 12 + Math.sin(baseTime * blob.speed * 0.4) * 8;
    return { x: blob.baseX + floatX, y: blob.baseY + floatY };
  }

  function getDistance(blob1, blob2, time) {
    var p1 = getBlobPosition(blob1, time);
    var p2 = getBlobPosition(blob2, time);
    var dx = p1.x - p2.x;
    var dy = p1.y - p2.y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  function animate() {
    var time = Date.now();

    // Update celestial elements
    for (var i = 0; i < celestialElements.length; i++) {
      var el = celestialElements[i];
      var div = celestialDivs[i];
      var baseTime;

      if (el.type === "star") {
        baseTime = time * 0.0001;
        var twinkle = el.baseOpacity + (el.baseOpacity * 0.8) * Math.sin(baseTime * el.twinkleSpeed * 50);
        div.style.opacity = Math.max(0.2, twinkle);
        div.style.transform = "translate(-50%, -50%)";
      } else if (el.type === "planet") {
        baseTime = time * 0.0005;
        var pid = parseInt(el.id.slice(-1));
        var isSpecial = pid === 1 || pid === 2;
        var baseDriftRange = isSpecial ? 25 + pid * 12 : 15 + pid * 8;
        var sm = isSpecial ? 0.25 : 1;
        var pdx = Math.cos(baseTime * el.driftSpeed * (1.5 + pid * 0.8) * sm) * baseDriftRange;
        var pdy = Math.sin(baseTime * el.driftSpeed * (1.5 + pid * 0.8) * sm) * baseDriftRange;
        var pRot = baseTime * el.driftSpeed * (1 + pid * 0.5) * sm;
        var pScale = 1 + 0.15 * Math.sin(baseTime * el.driftSpeed * (5 + pid * 2) * sm);

        var pAmp, maxBr;
        if (pid === 1) { pAmp = 0.25; maxBr = 0.765; }
        else if (pid === 2) { pAmp = 0.25; maxBr = 0.6375; }
        else { pAmp = 0.4; maxBr = 1; }

        var pPulse = el.baseOpacity + (el.baseOpacity * pAmp) * Math.sin(baseTime * el.driftSpeed * (6 + pid * 2) * sm);
        var fOp = Math.max(0.4, pPulse) * maxBr;

        var glowColor = pid === 0 ? "74,144,226" : pid === 1 ? "255,107,53" : "156,39,176";
        div.style.opacity = fOp;
        div.style.transform = "translate(calc(-50% + " + pdx + "px), calc(-50% + " + pdy + "px)) rotate(" + pRot + "deg) scale(" + pScale + ")";
        div.style.boxShadow = "0 0 " + (el.size * 0.8) + "px " + (el.size * 0.3) + "px rgba(" + glowColor + ", 0.4)";
      } else if (el.type === "galaxy") {
        baseTime = time * 0.0007;
        var gid = parseInt(el.id.slice(-1));
        var uniqueOff = el.id === "galaxy-2" ? 0.7 : 1;
        var gRot = baseTime * el.rotationSpeed * (12 + gid * 3) * uniqueOff;
        var gScale = 1 + (0.12 + gid * 0.03) * Math.sin(baseTime * el.rotationSpeed * (18 + gid * 4));
        var gdx = Math.cos(baseTime * el.rotationSpeed * (4 + gid * 2)) * (2 + gid);
        var gdy = Math.sin(baseTime * el.rotationSpeed * (4 + gid * 2)) * (2 + gid);
        var gPulse = el.baseOpacity + (el.baseOpacity * (0.25 + gid * 0.05)) * Math.sin(baseTime * el.rotationSpeed * (22 + gid * 6));

        div.style.opacity = Math.max(0.1, gPulse);
        div.style.transform = "translate(calc(-50% + " + gdx + "px), calc(-50% + " + gdy + "px)) rotate(" + gRot + "deg) scale(" + gScale + ")";
      }
    }

    // Update cloud blobs
    for (var i = 0; i < cloudBlobs.length; i++) {
      var blob = cloudBlobs[i];
      var div = blobDivs[i];
      var baseTime = time * 0.0005;

      var mergeInfluence = 0;
      var mergeDirX = 0, mergeDirY = 0;

      for (var j = 0; j < cloudBlobs.length; j++) {
        if (cloudBlobs[j].id !== blob.id) {
          var dist = getDistance(blob, cloudBlobs[j], time);
          var threshold = 25;
          if (dist < threshold) {
            var influence = 1 - (dist / threshold);
            mergeInfluence = Math.max(mergeInfluence, influence);
            var otherPos = getBlobPosition(cloudBlobs[j], time);
            var blobPos = getBlobPosition(blob, time);
            var ddx = otherPos.x - blobPos.x;
            var ddy = otherPos.y - blobPos.y;
            var len = Math.sqrt(ddx * ddx + ddy * ddy) || 1;
            mergeDirX += (ddx / len) * influence;
            mergeDirY += (ddy / len) * influence;
          }
        }
      }

      var floatX = Math.sin(baseTime * blob.speed) * 15 + Math.cos(baseTime * blob.speed * 0.3) * 10 + mergeDirX * 8;
      var floatY = Math.cos(baseTime * blob.speed * 0.7) * 12 + Math.sin(baseTime * blob.speed * 0.4) * 8 + mergeDirY * 8;
      var bx = blob.baseX + floatX;
      var by = blob.baseY + floatY;

      var baseSizeMorph = 0.6 + 0.6 * Math.sin(baseTime * blob.speed * 0.8) + 0.3 * Math.cos(baseTime * blob.speed * 0.6);
      var mergeSizeBoost = 1 + mergeInfluence * 0.6;
      var sizeMorph = baseSizeMorph * mergeSizeBoost;
      var bSize = blob.baseSize * sizeMorph;

      var personality = blob.id % 3;
      var sf1 = baseTime * blob.speed * (0.8 + personality * 0.2);
      var sf2 = baseTime * blob.speed * (1.1 + personality * 0.3);
      var sf3 = baseTime * blob.speed * (0.7 + personality * 0.15);
      var sf4 = baseTime * blob.speed * (1.3 + personality * 0.35);

      var ms = 1 + mergeInfluence * 1.2;
      var c1 = (5 + 60 * Math.sin(sf1) + 35 * Math.cos(sf3)) * ms;
      var c2 = (25 + 50 * Math.cos(sf2) + 30 * Math.sin(sf4)) * ms;
      var c3 = (10 + 65 * Math.sin(sf3 * 1.3) + 40 * Math.cos(sf1)) * ms;
      var c4 = (35 + 45 * Math.cos(sf4 * 0.7) + 50 * Math.sin(sf2)) * ms;
      var c5 = (5 + 70 * Math.sin(sf1 * 1.6) + 25 * Math.cos(sf3)) * ms;
      var c6 = (20 + 55 * Math.cos(sf2 * 1.4) + 45 * Math.sin(sf4)) * ms;
      var c7 = (15 + 60 * Math.sin(sf3 * 0.9) + 35 * Math.cos(sf1)) * ms;
      var c8 = (30 + 40 * Math.cos(sf4 * 1.2) + 55 * Math.sin(sf2)) * ms;

      var baseColor = spectrumColors[blob.colorIndex];
      var colorShift = 15 * Math.sin(baseTime * blob.speed * 0.2);
      var ch = ((baseColor.h + colorShift + mergeInfluence * 30) % 360 + 360) % 360;
      var cs = baseColor.s + 5 * Math.cos(baseTime * blob.speed * 0.3);
      var cl = baseColor.l + 3 * Math.sin(baseTime * blob.speed * 0.25) + mergeInfluence * 8;

      var depthOpacity = blob.depth === "background" ? 0.25 : 0.35;
      var depthBlur = blob.depth === "background" ? 50 : 30;
      var mergeOpacity = depthOpacity * (1 + mergeInfluence * 0.6);

      var rotation = 15 * Math.sin(baseTime * blob.speed * 0.3) + mergeInfluence * 20;
      var skewX = 5 * Math.cos(baseTime * blob.speed * 0.4) + mergeDirX * 10;

      div.style.left = bx + "%";
      div.style.top = by + "%";
      div.style.width = bSize + "px";
      div.style.height = bSize + "px";
      div.style.opacity = mergeOpacity;
      div.style.filter = "blur(" + depthBlur + "px)";
      div.style.borderRadius = c1 + "% " + c2 + "% " + c3 + "% " + c4 + "% / " + c5 + "% " + c6 + "% " + c7 + "% " + c8 + "%";
      div.style.transform = "translate(-50%, -50%) rotate(" + rotation + "deg) skewX(" + skewX + "deg)";

      var ch2 = (ch + 30) % 360;
      var ch3 = (ch + 60) % 360;
      div.style.background = "radial-gradient(ellipse at 40% 30%, hsl(" + ch + "," + cs + "%," + cl + "%) 0%, hsl(" + ch2 + "," + (cs * 0.8) + "%," + (cl * 0.9) + "%) 25%, hsl(" + ch3 + "," + (cs * 0.6) + "%," + (cl * 0.8) + "%) 50%, transparent 75%)";
    }

    requestAnimationFrame(animate);
  }

  requestAnimationFrame(animate);
}
