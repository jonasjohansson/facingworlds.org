// gui-controls.js — Simple GUI for tweaking animation values
AFRAME.registerComponent("gui-controls", {
  schema: {
    enabled: { type: "boolean", default: true },
    position: { type: "vec3", default: { x: 10, y: 10, z: 0 } },
  },

  init() {
    this.gui = null;
    this.controls = {};
    this.setupGUI();
  },

  setupGUI() {
    if (!this.data.enabled) return;

    // Create GUI container
    this.gui = document.createElement("div");
    this.gui.style.cssText = `
      position: fixed;
      top: ${this.data.position.y}px;
      left: ${this.data.position.x}px;
      background: rgba(0, 0, 0, 0.8);
      color: white;
      padding: 15px;
      border-radius: 8px;
      font-family: Arial, sans-serif;
      font-size: 12px;
      z-index: 1000;
      min-width: 250px;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
    `;

    // Add title
    const title = document.createElement("h3");
    title.textContent = "Animation Controls";
    title.style.cssText = "margin: 0 0 10px 0; color: #4CAF50; font-size: 14px;";
    this.gui.appendChild(title);

    // Create controls for animated materials
    this.createMaterialControls();
    this.createCurtainControls();
    this.createAudioControls();
    this.createGeneralControls();

    // Add to document
    document.body.appendChild(this.gui);
  },

  createMaterialControls() {
    const section = this.createSection("Map Materials");

    // Glow toggle
    this.addToggle(section, "Enable Glow", "enableGlow", true, (value) => {
      this.updateAnimatedMaterials("enableGlow", value);
    });

    // Pulse toggle
    this.addToggle(section, "Enable Pulse", "enablePulse", true, (value) => {
      this.updateAnimatedMaterials("enablePulse", value);
    });

    // Color shift toggle
    this.addToggle(section, "Enable Color Shift", "enableColorShift", false, (value) => {
      this.updateAnimatedMaterials("enableColorShift", value);
    });

    // Speed slider
    this.addSlider(section, "Animation Speed", "materialSpeed", 0.5, 0, 2, 0.1, (value) => {
      this.updateAnimatedMaterials("speed", value);
    });

    // Material properties
    this.addSlider(section, "Roughness", "materialRoughness", 0.8, 0, 1, 0.1, (value) => {
      this.updateAnimatedMaterials("roughness", value);
    });

    this.addSlider(section, "Metallic", "materialMetallic", 0.0, 0, 1, 0.1, (value) => {
      this.updateAnimatedMaterials("metallic", value);
    });

    this.addSlider(section, "Emissive Intensity", "materialEmissiveIntensity", 0.0, 0, 2, 0.1, (value) => {
      this.updateAnimatedMaterials("emissiveIntensity", value);
    });

    // Advanced animation controls
    this.addSelect(
      section,
      "Animation Type",
      "materialAnimationType",
      "opacity",
      ["opacity", "metallic", "roughness", "emissive", "color"],
      (value) => {
        this.updateAdvancedMaterialAnimation("animationType", value);
      }
    );

    this.addSlider(section, "Animation Speed", "materialAnimationSpeed", 1.0, 0, 3, 0.1, (value) => {
      this.updateAdvancedMaterialAnimation("speed", value);
    });

    this.addSlider(section, "Animation Intensity", "materialAnimationIntensity", 1.0, 0, 2, 0.1, (value) => {
      this.updateAdvancedMaterialAnimation("intensity", value);
    });

    this.addSlider(section, "Min Value", "materialMinValue", 0.3, 0, 1, 0.1, (value) => {
      this.updateAdvancedMaterialAnimation("minValue", value);
    });

    this.addSlider(section, "Max Value", "materialMaxValue", 1.0, 0, 1, 0.1, (value) => {
      this.updateAdvancedMaterialAnimation("maxValue", value);
    });

    this.addToggle(section, "Emissive Glow", "materialEmissiveGlow", true, (value) => {
      this.updateAdvancedMaterialAnimation("emissiveGlow", value);
    });
  },

  createCurtainControls() {
    const section = this.createSection("Animated Curtain");

    // Wind strength
    this.addSlider(section, "Wind Strength", "windStrength", 1.5, 0, 3, 0.1, (value) => {
      this.updateCurtain("windStrength", value);
    });

    // Wind speed
    this.addSlider(section, "Wind Speed", "windSpeed", 1.2, 0, 3, 0.1, (value) => {
      this.updateCurtain("windSpeed", value);
    });

    // Width
    this.addSlider(section, "Width", "curtainWidth", 6, 2, 10, 0.5, (value) => {
      this.updateCurtain("width", value);
    });

    // Height
    this.addSlider(section, "Height", "curtainHeight", 4, 2, 8, 0.5, (value) => {
      this.updateCurtain("height", value);
    });

    // Color picker
    this.addColorPicker(section, "Color", "curtainColor", "#8B4513", (value) => {
      this.updateCurtain("color", value);
    });

    // Texture selector
    this.addSelect(section, "Texture", "curtainTexture", "fabric", ["fabric", "silk", "velvet"], (value) => {
      this.updateCurtain("texture", value);
    });

    // Opacity slider
    this.addSlider(section, "Opacity", "curtainOpacity", 0.8, 0, 1, 0.1, (value) => {
      this.updateCurtain("opacity", value);
    });

    // Curtain material properties
    this.addSlider(section, "Roughness", "curtainRoughness", 0.8, 0, 1, 0.1, (value) => {
      this.updateCurtain("roughness", value);
    });

    this.addSlider(section, "Metallic", "curtainMetallic", 0.1, 0, 1, 0.1, (value) => {
      this.updateCurtain("metallic", value);
    });

    this.addSlider(section, "Emissive Intensity", "curtainEmissiveIntensity", 0.0, 0, 2, 0.1, (value) => {
      this.updateCurtain("emissiveIntensity", value);
    });
  },

  createGeneralControls() {
    const section = this.createSection("General");

    // Toggle all animations
    this.addToggle(section, "All Animations", "allAnimations", true, (value) => {
      this.toggleAllAnimations(value);
    });

    // Reset button
    this.addButton(section, "Reset to Defaults", () => {
      this.resetToDefaults();
    });

    // Hide/Show GUI
    this.addButton(section, "Hide GUI", () => {
      this.toggleGUI();
    });
  },

  createAudioControls() {
    const section = this.createSection("Audio");

    // Background music volume
    this.addSlider(section, "Music Volume", "musicVolume", 0.3, 0, 1, 0.1, (value) => {
      this.updateBackgroundMusic("volume", value);
    });

    // Start music on first bullet
    this.addToggle(section, "Start Music on First Bullet", "startOnFirstBullet", true, (value) => {
      this.updateBackgroundMusic("startOnFirstBullet", value);
    });

    // Space environment toggle
    this.addToggle(section, "Space Environment", "spaceEnvironment", true, (value) => {
      this.updateSpaceEnvironment("enabled", value);
    });

    // Asteroid count
    this.addSlider(section, "Asteroid Count", "asteroidCount", 15, 0, 30, 1, (value) => {
      this.updateSpaceEnvironment("asteroidCount", value);
    });

    // Asteroid speed
    this.addSlider(section, "Asteroid Speed", "asteroidSpeed", 0.5, 0, 2, 0.1, (value) => {
      this.updateSpaceEnvironment("asteroidSpeed", value);
    });
  },

  createSection(title) {
    const section = document.createElement("div");
    section.style.cssText = "margin-bottom: 15px; border-bottom: 1px solid #333; padding-bottom: 10px;";

    const header = document.createElement("h4");
    header.textContent = title;
    header.style.cssText = "margin: 0 0 8px 0; color: #FFC107; font-size: 12px;";
    section.appendChild(header);

    this.gui.appendChild(section);
    return section;
  },

  addToggle(section, label, key, defaultValue, callback) {
    const container = document.createElement("div");
    container.style.cssText = "display: flex; justify-content: space-between; align-items: center; margin: 5px 0;";

    const labelEl = document.createElement("span");
    labelEl.textContent = label;
    labelEl.style.cssText = "flex: 1;";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = defaultValue;
    checkbox.style.cssText = "margin-left: 10px;";

    checkbox.addEventListener("change", (e) => {
      this.controls[key] = e.target.checked;
      callback(e.target.checked);
    });

    container.appendChild(labelEl);
    container.appendChild(checkbox);
    section.appendChild(container);

    this.controls[key] = defaultValue;
  },

  addSlider(section, label, key, defaultValue, min, max, step, callback) {
    const container = document.createElement("div");
    container.style.cssText = "margin: 5px 0;";

    const labelEl = document.createElement("div");
    labelEl.textContent = `${label}: ${defaultValue}`;
    labelEl.style.cssText = "margin-bottom: 3px; font-size: 11px;";

    const slider = document.createElement("input");
    slider.type = "range";
    slider.min = min;
    slider.max = max;
    slider.step = step;
    slider.value = defaultValue;
    slider.style.cssText = "width: 100%;";

    slider.addEventListener("input", (e) => {
      const value = parseFloat(e.target.value);
      labelEl.textContent = `${label}: ${value.toFixed(2)}`;
      this.controls[key] = value;
      callback(value);
    });

    container.appendChild(labelEl);
    container.appendChild(slider);
    section.appendChild(container);

    this.controls[key] = defaultValue;
  },

  addColorPicker(section, label, key, defaultValue, callback) {
    const container = document.createElement("div");
    container.style.cssText = "margin: 5px 0;";

    const labelEl = document.createElement("div");
    labelEl.textContent = label;
    labelEl.style.cssText = "margin-bottom: 3px; font-size: 11px;";

    const colorInput = document.createElement("input");
    colorInput.type = "color";
    colorInput.value = defaultValue;
    colorInput.style.cssText = "width: 100%; height: 25px; border: none; border-radius: 4px;";

    colorInput.addEventListener("change", (e) => {
      this.controls[key] = e.target.value;
      callback(e.target.value);
    });

    container.appendChild(labelEl);
    container.appendChild(colorInput);
    section.appendChild(container);

    this.controls[key] = defaultValue;
  },

  addButton(section, label, callback) {
    const button = document.createElement("button");
    button.textContent = label;
    button.style.cssText = `
      width: 100%;
      padding: 8px;
      margin: 5px 0;
      background: #4CAF50;
      color: white;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      font-size: 11px;
    `;

    button.addEventListener("click", callback);
    section.appendChild(button);
  },

  addSelect(section, label, key, defaultValue, options, callback) {
    const container = document.createElement("div");
    container.style.cssText = "margin: 5px 0;";

    const labelEl = document.createElement("div");
    labelEl.textContent = label;
    labelEl.style.cssText = "margin-bottom: 3px; font-size: 11px;";

    const select = document.createElement("select");
    select.style.cssText = "width: 100%; padding: 4px; border: 1px solid #555; background: #333; color: white; border-radius: 4px;";

    options.forEach((option) => {
      const optionEl = document.createElement("option");
      optionEl.value = option;
      optionEl.textContent = option.charAt(0).toUpperCase() + option.slice(1);
      if (option === defaultValue) optionEl.selected = true;
      select.appendChild(optionEl);
    });

    select.addEventListener("change", (e) => {
      this.controls[key] = e.target.value;
      callback(e.target.value);
    });

    container.appendChild(labelEl);
    container.appendChild(select);
    section.appendChild(container);

    this.controls[key] = defaultValue;
  },

  updateAnimatedMaterials(property, value) {
    const worldEntity = document.querySelector("#world");
    if (worldEntity && worldEntity.components["animated-materials"]) {
      console.log(`[gui-controls] Updating animated-materials: ${property} = ${value}`);
      worldEntity.setAttribute("animated-materials", property, value);
    } else {
      console.warn("[gui-controls] World entity or animated-materials component not found");
    }
  },

  updateCurtain(property, value) {
    const curtainEntity = document.querySelector("[animated-curtain]");
    if (curtainEntity && curtainEntity.components["animated-curtain"]) {
      console.log(`[gui-controls] Updating curtain: ${property} = ${value}`);
      curtainEntity.setAttribute("animated-curtain", property, value);
    } else {
      console.warn("[gui-controls] Curtain entity or animated-curtain component not found");
    }
  },

  updateAdvancedMaterialAnimation(property, value) {
    const worldEntity = document.querySelector("#world");
    if (worldEntity && worldEntity.components["advanced-material-animation"]) {
      console.log(`[gui-controls] Updating advanced-material-animation: ${property} = ${value}`);
      worldEntity.setAttribute("advanced-material-animation", property, value);
    } else {
      console.warn("[gui-controls] World entity or advanced-material-animation component not found");
    }
  },

  updateBackgroundMusic(property, value) {
    const musicEntity = document.querySelector("[background-music]");
    if (musicEntity && musicEntity.components["background-music"]) {
      console.log(`[gui-controls] Updating background-music: ${property} = ${value}`);
      musicEntity.setAttribute("background-music", property, value);
    } else {
      console.warn("[gui-controls] Background music entity not found");
    }
  },

  updateSpaceEnvironment(property, value) {
    const spaceEntity = document.querySelector("[space-environment]");
    if (spaceEntity && spaceEntity.components["space-environment"]) {
      console.log(`[gui-controls] Updating space-environment: ${property} = ${value}`);
      spaceEntity.setAttribute("space-environment", property, value);
    } else {
      console.warn("[gui-controls] Space environment entity not found");
    }
  },

  toggleAllAnimations(enabled) {
    // Toggle animated materials
    this.updateAnimatedMaterials("enabled", enabled);

    // Toggle curtain
    const curtainEntity = document.querySelector("[animated-curtain]");
    if (curtainEntity) {
      curtainEntity.setAttribute("animated-curtain", "enabled", enabled);
    }
  },

  resetToDefaults() {
    // Reset material controls
    this.updateAnimatedMaterials("enableGlow", true);
    this.updateAnimatedMaterials("enablePulse", true);
    this.updateAnimatedMaterials("enableColorShift", false);
    this.updateAnimatedMaterials("speed", 0.5);

    // Reset curtain controls
    this.updateCurtain("windStrength", 1.5);
    this.updateCurtain("windSpeed", 1.2);
    this.updateCurtain("width", 6);
    this.updateCurtain("height", 4);
    this.updateCurtain("color", "#8B4513");

    // Reload the page to reset GUI
    setTimeout(() => {
      window.location.reload();
    }, 500);
  },

  toggleGUI() {
    if (this.gui) {
      this.gui.style.display = this.gui.style.display === "none" ? "block" : "none";
    }
  },

  remove() {
    if (this.gui && this.gui.parentNode) {
      this.gui.parentNode.removeChild(this.gui);
    }
  },
});
