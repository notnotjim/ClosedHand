import React, { useState, useEffect, useMemo } from 'react';

const AmbientBackground = () => {
  const [animationTime, setAnimationTime] = useState(0);

  useEffect(() => {
    const animate = () => {
      setAnimationTime(Date.now());
      requestAnimationFrame(animate);
    };
    requestAnimationFrame(animate);
  }, []);

  // Simplified color palette 
  const spectrumColors = [
    { h: 280, s: 60, l: 35 }, // Purple
    { h: 220, s: 55, l: 30 }, // Blue
    { h: 340, s: 50, l: 35 }, // Pink
    { h: 180, s: 45, l: 28 }  // Cyan
  ];

  // Fewer blobs with more spacing for better merging visibility
  const cloudBlobs = [
    {
      id: 1,
      baseX: 20,
      baseY: 30,
      baseSize: 450,
      colorIndex: 0,
      speed: 0.3,
      depth: 'background'
    },
    {
      id: 2,
      baseX: 70,
      baseY: 20,
      baseSize: 380,
      colorIndex: 1,
      speed: 0.35,
      depth: 'midground'
    },
    {
      id: 3,
      baseX: 15,
      baseY: 75,
      baseSize: 420,
      colorIndex: 2,
      speed: 0.28,
      depth: 'background'
    },
    {
      id: 4,
      baseX: 80,
      baseY: 65,
      baseSize: 350,
      colorIndex: 3,
      speed: 0.4,
      depth: 'midground'
    }
  ];

  // Fixed celestial elements to prevent flickering
  const celestialElements = useMemo(() => [
    // Stars - reduced maximum size from 5px to 3.5px with proportional scaling
    ...Array.from({ length: 35 }, (_, i) => ({
      id: `star-${i}`,
      type: 'star',
      x: (i * 17 + 5) % 100, // Fixed positions instead of random
      y: (i * 23 + 10) % 100,
      size: 1.5 + (i % 4) * 0.5, // Changed from 2 + (i % 4) to 1.5 + (i % 4) * 0.5 for proportional reduction
      baseOpacity: 0.4 + (i % 3) * 0.2, // Much higher opacity
      twinkleSpeed: 0.1 + (i % 5) * 0.05,
      hue: 200 + (i % 6) * 10
    })),
    // Distant planets - enhanced visibility and size
    ...Array.from({ length: 3 }, (_, i) => ({
      id: `planet-${i}`,
      type: 'planet',
      x: [15, 85, 25][i],
      y: [20, 30, 70][i],
      size: 20 + i * 5, // Increased from 12 + i * 2.5 for better visibility
      baseOpacity: 0.5 + i * 0.1, // Increased from 0.15 + i * 0.05 for much better visibility
      driftSpeed: 0.3 + i * 0.15,
      hue: 220 + i * 15,
      driftDirection: (i * Math.PI) / 2
    })),
    // Distant galaxies - made visible, added converted planet
    ...Array.from({ length: 3 }, (_, i) => ({
      id: `galaxy-${i}`,
      type: 'galaxy',
      x: i === 0 ? 20 : i === 1 ? 80 : 75,
      y: i === 0 ? 25 : i === 1 ? 75 : 80,
      size: i === 2 ? 37 : i === 1 ? 20 : 35, // Reduced all sizes by 50%
      baseOpacity: 0.25 + i * 0.15, // Much higher opacity
      rotationSpeed: 0.02 + i * 0.01,
      hue: 260 + i * 20
    }))
  ], []);

  const getCelestialTransform = (element: any, time: number) => {
    // Different timing for different elements
    let baseTime;
    switch (element.type) {
      case 'star':
        baseTime = time * 0.0001; // Original slow speed for subtle twinkling
        break;
      case 'planet':
        baseTime = time * 0.0005; // Medium-slow for ethereal movement
        break;
      case 'galaxy':
        baseTime = time * 0.0007; // Medium-slow for gentle rotation
        break;
      default:
        baseTime = time * 0.0001;
    }
    
    switch (element.type) {
      case 'star':
        // Enhanced twinkle effect with visible changes
        const twinkle = element.baseOpacity + 
          (element.baseOpacity * 0.8) * Math.sin(baseTime * element.twinkleSpeed * 50);
        return {
          opacity: Math.max(0.2, twinkle), // Higher minimum opacity
          transform: `translate(-50%, -50%)`,
          filter: 'none' // Remove blur for better visibility
        };
        
      case 'planet':
        // Much broader range and slower movement like galaxies
        const planetId = parseInt(element.id.slice(-1));
        
        // Special handling for bottom left (planet-2) and top right (planet-1)
        const isSpecialPlanet = planetId === 1 || planetId === 2;
        const baseDriftRange = isSpecialPlanet ? 25 + planetId * 12 : 15 + planetId * 8; // Broader range for special planets
        const speedMultiplier = isSpecialPlanet ? 0.25 : 1; // 75% slower (25% of current speed) for special planets
        
        const planetDriftRange = baseDriftRange;
        const planetDriftX = Math.cos(baseTime * element.driftSpeed * (1.5 + planetId * 0.8) * speedMultiplier) * planetDriftRange;
        const planetDriftY = Math.sin(baseTime * element.driftSpeed * (1.5 + planetId * 0.8) * speedMultiplier) * planetDriftRange;
        
        // Much slower gentle rotation
        const planetRotation = baseTime * element.driftSpeed * (1 + planetId * 0.5) * speedMultiplier;
        
        // Simple scale pulsation - much slower for gentler effect
        const planetScalePulse = 1 + 0.15 * Math.sin(baseTime * element.driftSpeed * (5 + planetId * 2) * speedMultiplier);
        
        // Simple opacity pulsation with brightness reduction for specific planets
        // Further reduce brightness by 15% for both special planets
        let pulsationAmplitude;
        let maxBrightnessReduction = 1;
        
        if (planetId === 1) { // Orange/red planet (top right) - now 23.5% less bright (10% + 15% of remaining)
          pulsationAmplitude = 0.25;
          maxBrightnessReduction = 0.765; // 0.9 * 0.85 = 23.5% total reduction
        } else if (planetId === 2) { // Purple planet (bottom left) - now 36.25% less bright (25% + 15% of remaining)
          pulsationAmplitude = 0.25;
          maxBrightnessReduction = 0.6375; // 0.75 * 0.85 = 36.25% total reduction
        } else {
          pulsationAmplitude = 0.4;
          maxBrightnessReduction = 1; // No reduction for other planets
        }
        
        const planetPulse = element.baseOpacity + 
          (element.baseOpacity * pulsationAmplitude) * Math.sin(baseTime * element.driftSpeed * (6 + planetId * 2) * speedMultiplier);
        
        // Apply brightness reduction to the final opacity
        const finalOpacity = Math.max(0.4, planetPulse) * maxBrightnessReduction;
        
        return {
          opacity: finalOpacity,
          transform: `translate(calc(-50% + ${planetDriftX}px), calc(-50% + ${planetDriftY}px)) rotate(${planetRotation}deg) scale(${planetScalePulse})`,
          filter: 'none',
          boxShadow: `0 0 ${element.size * 0.8}px ${element.size * 0.3}px rgba(${planetId === 0 ? '74, 144, 226' : planetId === 1 ? '255, 107, 53' : '156, 39, 176'}, 0.4)` // Add glow effect
        };
        
      case 'galaxy':
        // Enhanced rotation with scale pulsation and drift - unique timing per galaxy
        const uniqueOffset = element.id === 'galaxy-2' ? 0.7 : 1; // Converted planet galaxy gets different timing
        const rotation = baseTime * element.rotationSpeed * (12 + element.id.slice(-1) * 3) * uniqueOffset;
        const scalePulse = 1 + (0.12 + element.id.slice(-1) * 0.03) * Math.sin(baseTime * element.rotationSpeed * (18 + element.id.slice(-1) * 4));
        const galaxyDriftX = Math.cos(baseTime * element.rotationSpeed * (4 + element.id.slice(-1) * 2)) * (2 + element.id.slice(-1));
        const galaxyDriftY = Math.sin(baseTime * element.rotationSpeed * (4 + element.id.slice(-1) * 2)) * (2 + element.id.slice(-1));
        
        // Enhanced opacity pulsation with unique frequencies
        const galaxyPulse = element.baseOpacity + 
          (element.baseOpacity * (0.25 + element.id.slice(-1) * 0.05)) * Math.sin(baseTime * element.rotationSpeed * (22 + element.id.slice(-1) * 6));
        
        return {
          opacity: Math.max(0.1, galaxyPulse),
          transform: `translate(calc(-50% + ${galaxyDriftX}px), calc(-50% + ${galaxyDriftY}px)) rotate(${rotation}deg) scale(${scalePulse})`,
          filter: 'none' // Remove blur for better visibility
        };
        
      default:
        return {
          opacity: element.baseOpacity,
          transform: `translate(-50%, -50%)`,
          filter: 'none'
        };
    }
  };

  // Calculate distance between two blobs
  const getDistance = (blob1: any, blob2: any, time: number) => {
    const transform1 = getBlobPosition(blob1, time);
    const transform2 = getBlobPosition(blob2, time);
    
    const dx = transform1.x - transform2.x;
    const dy = transform1.y - transform2.y;
    return Math.sqrt(dx * dx + dy * dy);
  };

  // Get just position for distance calculation
  const getBlobPosition = (blob: typeof cloudBlobs[0], time: number) => {
    const baseTime = time * 0.0005; // Slightly faster overall timing
    const floatX = Math.sin(baseTime * blob.speed) * 15 + 
                   Math.cos(baseTime * blob.speed * 0.3) * 10;
    const floatY = Math.cos(baseTime * blob.speed * 0.7) * 12 + 
                   Math.sin(baseTime * blob.speed * 0.4) * 8;
    
    return {
      x: blob.baseX + floatX,
      y: blob.baseY + floatY
    };
  };

  const getBlobTransform = (blob: typeof cloudBlobs[0], time: number) => {
    const baseTime = time * 0.0005; // Matched faster timing
    
    // Check for nearby blobs to create merge effect
    let mergeInfluence = 0;
    let mergeDirection = { x: 0, y: 0 };
    
    cloudBlobs.forEach(otherBlob => {
      if (otherBlob.id !== blob.id) {
        const distance = getDistance(blob, otherBlob, time);
        const mergeThreshold = 25; // Distance threshold for merging effect
        
        if (distance < mergeThreshold) {
          const influence = 1 - (distance / mergeThreshold);
          mergeInfluence = Math.max(mergeInfluence, influence);
          
          // Calculate direction towards other blob for gloopy effect
          const otherPos = getBlobPosition(otherBlob, time);
          const blobPos = getBlobPosition(blob, time);
          const dx = otherPos.x - blobPos.x;
          const dy = otherPos.y - blobPos.y;
          const length = Math.sqrt(dx * dx + dy * dy) || 1;
          
          mergeDirection.x += (dx / length) * influence;
          mergeDirection.y += (dy / length) * influence;
        }
      }
    });
    
    // Organic floating movement with merge influence
    const floatX = Math.sin(baseTime * blob.speed) * 15 + 
                   Math.cos(baseTime * blob.speed * 0.3) * 10 +
                   mergeDirection.x * 8;
    const floatY = Math.cos(baseTime * blob.speed * 0.7) * 12 + 
                   Math.sin(baseTime * blob.speed * 0.4) * 8 +
                   mergeDirection.y * 8;
    
    // Enhanced size morphing with dramatic variation for visible morphing
    const baseSizeMorph = 0.6 + 
      0.6 * Math.sin(baseTime * blob.speed * 0.8) + 
      0.3 * Math.cos(baseTime * blob.speed * 0.6);
    const mergeSizeBoost = 1 + mergeInfluence * 0.6;
    const sizeMorph = baseSizeMorph * mergeSizeBoost;
    
    // Dramatic shape morphing with faster frequencies for visible deformation
    const personality = blob.id % 3;
    const shapeFreq1 = baseTime * blob.speed * (0.8 + personality * 0.2);
    const shapeFreq2 = baseTime * blob.speed * (1.1 + personality * 0.3);
    const shapeFreq3 = baseTime * blob.speed * (0.7 + personality * 0.15);
    const shapeFreq4 = baseTime * blob.speed * (1.3 + personality * 0.35);
    
    // Extreme organic deformation with dramatic corner variations for visible morphing
    const mergeStretch = 1 + mergeInfluence * 1.2;
    const corner1 = (5 + 60 * Math.sin(shapeFreq1) + 35 * Math.cos(shapeFreq3)) * mergeStretch;
    const corner2 = (25 + 50 * Math.cos(shapeFreq2) + 30 * Math.sin(shapeFreq4)) * mergeStretch;
    const corner3 = (10 + 65 * Math.sin(shapeFreq3 * 1.3) + 40 * Math.cos(shapeFreq1)) * mergeStretch;
    const corner4 = (35 + 45 * Math.cos(shapeFreq4 * 0.7) + 50 * Math.sin(shapeFreq2)) * mergeStretch;
    const corner5 = (5 + 70 * Math.sin(shapeFreq1 * 1.6) + 25 * Math.cos(shapeFreq3)) * mergeStretch;
    const corner6 = (20 + 55 * Math.cos(shapeFreq2 * 1.4) + 45 * Math.sin(shapeFreq4)) * mergeStretch;
    const corner7 = (15 + 60 * Math.sin(shapeFreq3 * 0.9) + 35 * Math.cos(shapeFreq1)) * mergeStretch;
    const corner8 = (30 + 40 * Math.cos(shapeFreq4 * 1.2) + 55 * Math.sin(shapeFreq2)) * mergeStretch;
    
    // Irregular 8-point border radius for organic gas shape
    const borderRadius = `${corner1}% ${corner2}% ${corner3}% ${corner4}% / ${corner5}% ${corner6}% ${corner7}% ${corner8}%`;
    
    // Color blending effect when merging
    const baseColor = spectrumColors[blob.colorIndex];
    const colorShift = 15 * Math.sin(baseTime * blob.speed * 0.2);
    const adjustedColor = {
      h: (baseColor.h + colorShift + mergeInfluence * 30 + 360) % 360,
      s: baseColor.s + 5 * Math.cos(baseTime * blob.speed * 0.3),
      l: baseColor.l + 3 * Math.sin(baseTime * blob.speed * 0.25) + mergeInfluence * 8
    };
    
    // Depth-based properties with increased opacity for visible colors
    const depthProps = blob.depth === 'background' ? 
      { opacity: 0.25, blur: 50 } :
      { opacity: 0.35, blur: 30 };
    
    // Increase opacity when merging for gloopy effect
    const mergeOpacity = depthProps.opacity * (1 + mergeInfluence * 0.6);
    
    return {
      x: blob.baseX + floatX,
      y: blob.baseY + floatY,
      size: blob.baseSize * sizeMorph,
      opacity: mergeOpacity,
      blur: depthProps.blur,
      color: adjustedColor,
      borderRadius,
      rotation: 15 * Math.sin(baseTime * blob.speed * 0.3) + mergeInfluence * 20,
      skewX: 5 * Math.cos(baseTime * blob.speed * 0.4) + mergeDirection.x * 10
    };
  };

  return (
    <div className="fixed inset-0 overflow-hidden pointer-events-none" style={{ zIndex: -1 }}>
      {/* Distant celestial elements for depth */}
      {celestialElements.map((element) => {
        const transform = getCelestialTransform(element, animationTime);
        
        return (
          <div
            key={element.id}
            className="absolute"
            style={{
              left: `${element.x}%`,
              top: `${element.y}%`,
              width: `${element.size}px`,
              height: `${element.size}px`,
              background: element.type === 'star' 
                ? `radial-gradient(circle, hsl(${element.hue}, 80%, 90%) 0%, hsl(${element.hue}, 60%, 70%) 50%, transparent 100%)`
                : element.type === 'planet'
                ? (() => {
                    const planetId = parseInt(element.id.slice(-1));
                    switch(planetId) {
                      case 0: // Earth-like - Blue/Green
                        return `radial-gradient(circle, #4A90E2 0%, #2E7D32 40%, #1565C0 80%, transparent 100%)`;
                      case 1: // Mars-like - Red/Orange  
                        return `radial-gradient(circle, #FF6B35 0%, #D84315 40%, #BF360C 80%, transparent 100%)`;
                      case 2: // Gas giant - Purple/Pink
                        return `radial-gradient(circle, #9C27B0 0%, #673AB7 40%, #3F51B5 80%, transparent 100%)`;
                      default:
                        return `radial-gradient(circle, hsl(${element.hue}, 60%, 45%) 0%, hsl(${element.hue + 20}, 50%, 35%) 60%, transparent 100%)`;
                    }
                  })()
                : element.id === 'galaxy-2' // Converted planet galaxy - much softer edges
                ? `radial-gradient(ellipse at 30% 40%, 
                    hsl(280, 70%, 50%) 0%,
                    hsl(260, 65%, 40%) 15%,
                    hsl(240, 60%, 35%) 30%,
                    hsla(220, 55%, 25%, 0.8) 45%,
                    hsla(200, 50%, 15%, 0.4) 60%,
                    transparent 75%)`
                : `radial-gradient(ellipse, 
                    hsl(${element.hue}, 70%, 40%) 0%,
                    hsl(${element.hue + 30}, 60%, 30%) 40%,
                    hsl(${element.hue}, 50%, 20%) 70%,
                    transparent 100%)`,
               borderRadius: element.type === 'galaxy' 
                ? (element.id === 'galaxy-2' ? '35% 65% 45% 55% / 60% 40% 70% 30%' : '40% 60% 30% 70%') // Spiral shape for converted planet
                : element.type === 'planet' 
                ? (() => {
                    const planetId = parseInt(element.id.slice(-1));
                    return planetId === 0 ? '47% 53% 52% 48%' : // Slightly oval Earth
                           planetId === 1 ? '45% 55% 50% 50%' : // Slightly irregular Mars
                           '49% 51% 48% 52%'; // Slightly oval gas giant
                  })()
                : '50%',
              opacity: transform.opacity,
              transform: transform.transform,
              filter: transform.filter,
              boxShadow: transform.boxShadow,
              mixBlendMode: 'normal', // Changed from 'screen' to 'normal'
              willChange: 'opacity, transform'
            }}
          />
        );
      })}
      
      {/* Floating gas blobs with merging effect */}
      {cloudBlobs.map((blob) => {
        const transform = getBlobTransform(blob, animationTime);
        
        return (
          <div
            key={blob.id}
            className="absolute will-change-transform"
            style={{
              left: `${transform.x}%`,
              top: `${transform.y}%`,
              width: `${transform.size}px`,
              height: `${transform.size}px`,
              background: `radial-gradient(ellipse at 40% 30%, 
                hsl(${transform.color.h}, ${transform.color.s}%, ${transform.color.l}%) 0%,
                hsl(${(transform.color.h + 30) % 360}, ${transform.color.s * 0.8}%, ${transform.color.l * 0.9}%) 25%,
                hsl(${(transform.color.h + 60) % 360}, ${transform.color.s * 0.6}%, ${transform.color.l * 0.8}%) 50%,
                transparent 75%)`,
              opacity: transform.opacity,
              filter: `blur(${transform.blur}px)`,
      borderRadius: transform.borderRadius,
      transform: `translate(-50%, -50%) rotate(${transform.rotation}deg) skewX(${transform.skewX}deg)`,
      mixBlendMode: 'screen',
      willChange: 'transform, border-radius, opacity'
            }}
          />
        );
      })}
    </div>
  );
};

export default AmbientBackground;
