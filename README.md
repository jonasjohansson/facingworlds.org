# UnrealFest Avatar Game

A multiplayer 3D avatar game built with A-Frame and WebSockets.

## Features

- **Multiplayer Support**: Real-time multiplayer with WebSocket networking
- **3D Environment**: Immersive 3D world with navigation mesh
- **Camera Controls**: Switch between 1st person, 3rd person, and overhead views (Press C)
- **Combat System**: Shoot bullets and hit targets
- **Character Animation**: Smooth character animations and movement
- **Health System**: Player health with visual feedback

## Project Structure

```
src/
├── core/                 # Core application files
│   ├── main.js          # Entry point
│   └── spawn.js         # Player spawning logic
├── network/             # Network functionality
│   └── network.js       # WebSocket networking
├── components/          # A-Frame components
│   ├── blaster.js       # Shooting system
│   ├── bullet.js        # Bullet physics
│   ├── camera-controls.js # Camera cycling
│   ├── character.js     # Character animation
│   ├── health.js        # Health system
│   └── remote-avatar.js # Remote player management
├── systems/             # A-Frame systems
│   ├── checker.js       # Checker floor
│   └── targets.js       # Target spawning
├── utils/               # Utility modules
│   ├── animation-helpers.js
│   ├── dom-helpers.js
│   ├── three-helpers.js
│   ├── environment.js   # Environment detection
│   ├── error-handler.js # Error handling
│   └── performance.js   # Performance monitoring
├── config/              # Configuration
│   └── game-config.js   # Game settings
└── 3d/                  # 3D assets
    ├── map.gltf
    ├── map_navmesh.gltf
    └── map.bin
```

## Getting Started

1. **Start the server**:

   ```bash
   cd server
   npm install
   npm start
   ```

2. **Open the game**:
   - Open `index.html` in a web browser
   - Or serve it with a local server for better performance

## Controls

- **WASD**: Move character
- **Mouse**: Look around (1st person) / Orbit camera (3rd person)
- **X**: Shoot
- **C**: Cycle camera modes (1st person → 3rd person → overhead)

## Camera Modes

1. **1st Person**: Camera inside character's head
2. **3rd Person**: Orbit camera around character (Unreal Tournament style)
3. **Overhead**: Top-down strategic view

## Development

### Configuration

Game settings can be modified in `src/config/game-config.js`:

- Network URLs (local vs production)
- Player health and movement settings
- Camera positions and angles
- Bullet physics and appearance
- Animation parameters

### Environment Detection

The game automatically detects development vs production environment:

- **Development**: Uses local WebSocket server (`ws://localhost:8080`)
- **Production**: Uses remote server (`https://unrealfest-server.onrender.com`)

### Error Handling

The game includes comprehensive error handling:

- Network connection errors
- Model loading failures
- Spawn failures
- Performance monitoring

### Performance Monitoring

Performance metrics are logged in development mode:

- FPS monitoring
- Memory usage tracking
- Slow operation detection

## Deployment

1. **Build for production**:

   - Update `src/config/game-config.js` if needed
   - Ensure server is running on production URL

2. **Deploy**:
   - Upload all files to web server
   - Ensure WebSocket server is accessible
   - Test multiplayer functionality

## Browser Support

- Modern browsers with WebGL support
- WebSocket support required
- ES6 modules support required

## License

MIT License
