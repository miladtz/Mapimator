export const createRichProductionBasemapProject = (projectCore, routeCore) => {
  const imageSha = '1'.repeat(64);
  const mediaSha = '2'.repeat(64);
  const imageAssetId = `asset_${imageSha}`;
  const mediaAssetId = `asset_${mediaSha}`;
  const pin = Object.assign(projectCore.createLayer('pin'), {
    id: 'fixture-pin',
    text: 'Tehran',
  });
  const region = Object.assign(projectCore.createLayer('region'), {
    id: 'fixture-region',
    regionGeometry: {
      type: 'Polygon',
      coordinates: [
        [
          [51, 35],
          [52, 35],
          [52, 36],
          [51, 36],
          [51, 35],
        ],
      ],
    },
  });
  const route = routeCore.createRouteLayer([
    { id: 'route-point-a', name: 'Tehran', longitude: 51.389, latitude: 35.689 },
    { id: 'route-point-b', name: 'Dubai', longitude: 55.271, latitude: 25.205 },
    { id: 'route-point-c', name: 'Cairo', longitude: 31.236, latitude: 30.044 },
  ]);
  route.id = 'fixture-route';
  const text = Object.assign(projectCore.createLayer('text'), {
    id: 'fixture-text',
    text: 'ایران · Iran',
  });
  const shape = Object.assign(projectCore.createLayer('shape'), { id: 'fixture-shape' });
  const arrow = Object.assign(projectCore.createLayer('shape'), {
    id: 'fixture-arrow',
    name: 'Arrow',
    shapeKind: 'arrow',
    shapePoints: [
      { id: 'arrow-start', x: 480, y: 260 },
      { id: 'arrow-end', x: 690, y: 320 },
    ],
  });
  const image = Object.assign(projectCore.createLayer('image'), {
    id: 'fixture-image',
    assetId: imageAssetId,
  });
  const media = Object.assign(projectCore.createLayer('animated-media'), {
    id: 'fixture-media',
    assetId: mediaAssetId,
    animatedMediaCycleDurationMs: 2000,
  });
  const layers = [region, route, shape, image, media, pin, text, arrow];
  const project = projectCore.createProject('Rich production basemap matrix');
  project.assets = [
    {
      id: imageAssetId,
      kind: 'image',
      filename: 'fixture.png',
      mediaType: 'image/png',
      sha256: imageSha,
      size: 128,
      width: 160,
      height: 90,
      packagePath: `assets/${imageSha}.png`,
    },
    {
      id: mediaAssetId,
      kind: 'image',
      filename: 'fixture.webp',
      mediaType: 'image/webp',
      sha256: mediaSha,
      size: 256,
      width: 160,
      height: 90,
      packagePath: `assets/${mediaSha}.webp`,
    },
  ];
  project.layers = layers;
  const cameras = [
    { x: -120, y: -40, zoom: 20, bearing: 15, pitch: 20 },
    { x: -640, y: -330, zoom: 100, bearing: 190, pitch: 45 },
    { x: -4200, y: -2100, zoom: 1000, bearing: 725, pitch: 70 },
  ];
  project.views = cameras.map((camera, index) => {
    const included = index === 1 ? layers.filter((layer) => layer.id !== image.id) : layers;
    const view = projectCore.createView(`Fixture View ${index + 1}`, included, camera, layers);
    view.id = `fixture-view-${index + 1}`;
    view.holdDuration = [3, 0, 4][index];
    return view;
  });
  project.transitions = [
    projectCore.createTransition(project.views[0].id, project.views[1].id, layers, project.views[0]),
    projectCore.createTransition(project.views[1].id, project.views[2].id, layers, project.views[1]),
  ].map((transition, index) => ({
    ...transition,
    id: `fixture-transition-${index + 1}`,
    duration: index === 0 ? 2.5 : 3.5,
  }));
  const routeAnimations = Object.fromEntries(
    route.routeSegments.map((section) => [
      section.id,
      {
        included: true,
        appearEnabled: true,
        appearType: 'draw-route',
        appearDuration: 1,
        vehicleEnabled: true,
        vehicleDuration: 4,
        vehicleType: 'car',
        vehicleFollowDirection: true,
        vehicleRepetitive: true,
        vehicleInterval: 1.25,
      },
    ]),
  );
  for (const segment of [...project.views, ...project.transitions]) {
    segment.layerConfigs[route.id] = {
      included: true,
      animation: { routeSegmentAnimations: structuredClone(routeAnimations) },
    };
    segment.layerConfigs[media.id] = {
      included: true,
      animation: {
        animatedMediaStartDelay: 0.25,
        animatedMediaDuration: 4,
        animatedMediaRepeatCountEnabled: true,
        animatedMediaRepeatCount: 2,
      },
    };
    segment.layerConfigs[text.id] = {
      included: true,
      animation: { appearEnabled: true, appearType: 'fade', appearDuration: 0.8 },
    };
  }
  return project;
};
