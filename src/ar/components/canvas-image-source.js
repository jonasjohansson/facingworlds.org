// Canvas-based image source component for AR debugging
AFRAME.registerComponent("canvas-image-source", {
  init: function () {
    // Load and draw the tracker image
    const img = new Image();
    img.onload = () => {
      // Create canvas with same aspect ratio as image
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d");

      // Set canvas size to match image aspect ratio
      canvas.width = img.width;
      canvas.height = img.height;

      // Draw image maintaining aspect ratio
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

      // Convert canvas to video stream
      const stream = canvas.captureStream(30); // 30 FPS
      const video = document.getElementById("tracker-video");

      if (video) {
        video.srcObject = stream;
        video
          .play()
          .then(() => {
            // Dispatch a custom event to signal that the video is ready
            document.dispatchEvent(new CustomEvent("ar-video-ready"));
          })
          .catch((err) => {
            console.error("Canvas Image Source: Error playing video:", err);
          });
      } else {
        console.error("Canvas Image Source: Video element not found");
      }
    };
    img.src = "assets/images/tracker.jpg";
  },
});
