# MediaPipe Tasks Vision (vendored)

`@mediapipe/tasks-vision` 1.0.1, Apache-2.0, © Google LLC.
https://www.npmjs.com/package/@mediapipe/tasks-vision

Only the SIMD WebAssembly build is kept (every current Chrome and Brave
supports WASM SIMD). The face model is `vendor/models/face_landmarker.task`
(float16, v1) from
https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task

Served locally so gaze works without network access and so the extension
ships no remote code. Used by `client/eyes.js`.
