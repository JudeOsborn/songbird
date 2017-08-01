/**
 * @license
 * Copyright 2016 Google Inc. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * @file Source model to spatialize an audio buffer.
 * @author Andrew Allen <bitllama@google.com>
 */

'use strict';

// Internal dependencies.
var Attenuation = require('./attenuation.js');
var AmbisonicEncoder = require('./ambisonic-encoder.js');
var Globals = require('./globals.js');

/**
 * @class Source
 * @description Source model to spatialize an audio buffer.
 * @param {Listener} listener Associated Listener.
 * @param {Object} options
 * @param {Number} options.minDistance Min. distance (in meters).
 * @param {Number} options.maxDistance Max. distance (in meters).
 * @param {Number} options.gain Gain (linear).
 * @param {Float32Array} options.position Position [x,y,z] (in meters).
 * @param {Float32Array} options.velocity Velocity [x,y,z] (in meters).
 * @param {Float32Array} options.orientation Orientation [x,y,z] (in meters).
 */
function Source (listener, options) {
  // Public variables.
  /**
   * Input to .connect() input AudioNodes to.
   * @member {AudioNode} input
   * @memberof Source
   */

  // Assign defaults for undefined options.
  if (options == undefined) {
    options = new Object();
  }
  if (options.gain == undefined) {
    options.gain = Globals.DefaultGainLinear;
  }
  if (options.position == undefined) {
    options.position = Globals.DefaultPosition;
  }
  if (options.velocity == undefined) {
    options.velocity = Globals.DefaultVelocity;
  }
  if (options.orientation == undefined) {
    options.orientation = Globals.DefaultOrientation;
  }

  this._listener = listener;
  this._position = new Float32Array(3);
  this._velocity = new Float32Array(3);
  this._orientation_q = new Float32Array(4);
  this._forward = new Float32Array(3);
  this._directivity_alpha = 0;
  this._directivity_order = listener._ambisonicOrder;

  // Create nodes.
  var context = listener._context;
  this.input = context.createGain();
  this._directivity = context.createGain();
  this._attenuation =
    new Attenuation(context, options);
  this._encoder =
    new AmbisonicEncoder(context, listener._ambisonicOrder);

  // Connect nodes.
  this.input.connect(this._attenuation.input);
  this.input.connect(listener._reverb.input);
  this._attenuation.output.connect(this._directivity);
  this._attenuation.output.connect(listener._reflections.input);
  this._directivity.connect(this._encoder.input);
  this._encoder.output.connect(listener.output);

  // Assign initial conditions.
  this.setPosition(options.position[0], options.position[1],
    options.position[2]);
  this.setVelocity(options.velocity[0], options.velocity[1],
    options.velocity[2]);
  this.setOrientation(options.orientation[0], options.orientation[1],
    options.orientation[2]);
  this.input.gain.value = options.gain;
}

/**
 * Set source's position (in meters).
 * @param {Number} x
 * @param {Number} y
 * @param {Number} z
 */
Source.prototype.setPosition = function(x, y, z) {
  var dx = new Float32Array(3);

  // Assign new position.
  this._position[0] = x;
  this._position[1] = y;
  this._position[2] = z;

  // Compute distance to listener.
  for (var i = 0; i < 3; i++) {
    dx[i] = this._position[i] - this._listener._position[i];
  }
  var distance = Math.sqrt(dx[0] * dx[0] + dx[1] * dx[1] + dx[2] * dx[2]);

  // Normalize direction vector.
  dx[0] /= distance;
  dx[1] /= distance;
  dx[2] /= distance;

  // Compute directivity pattern.
  this._directivity.gain.value = computeDirectivity(this._forward, dx,
    this._directivity_alpha, this._directivity_order);

  // Compuete angle of direction vector.
  var azimuth = Math.atan2(-dx[0], dx[2]) * Globals.OneEightyByPi;
  var elevation = Math.atan2(dx[1],
    Math.sqrt(dx[0] * dx[0] + dx[2] * dx[2])) * Globals.OneEightyByPi;

  // Set distance/direction values.
  this._attenuation.setDistance(distance);
  this._encoder.setDirection(azimuth, elevation);
}

/**
 * Set source's angle relative to the listener's position.
 * @param {Number} azimuth (in degrees).
 * @param {Number} elevation (in degrees).
 * @param {Number} distance (in meters).
 */
Source.prototype.setAngleFromListener = function(azimuth, elevation, distance) {
  if (elevation == undefined) {
    elevation = 0;
  }
  if (distance == undefined) {
    distance = 1;
  }
  var theta = azimuth * Globals.PiByOneEighty;
  var phi = elevation * Globals.PiByOneEighty;

  // Polar -> Cartesian (direction from listener).
  var x = -Math.sin(theta) * Math.cos(phi);
  var y = Math.sin(theta);
  var z = -Math.cos(theta) * Math.cos(phi);

  // Compute directivity pattern.
  this._directivity.gain.value = computeDirectivity(this._forward, [x, y, z],
    this._directivity_alpha, this._directivity_order);

  // Assign new position based on relationship to listener.
  this._position[0] = this._listener._position[0] + x;
  this._position[1] = this._listener._position[1] + y;
  this._position[2] = this._listener._position[2] + z;

  // Set distance/direction values.
  this._attenuation.setDistance(distance);
  this._encoder.setDirection(-azimuth, elevation);
}

/**
 * Set source's forward orientation.
 * @param {Number} roll
 * @param {Number} pitch
 * @param {Number} yaw
 */
Source.prototype.setOrientation = function(roll, pitch, yaw) {
  this._orientation_q = toQuaternion(roll, pitch, yaw);

  // Compute forward vector.
  var forward = hamiltonProduct(
    hamiltonProduct(this._orientation_q, [0, 0, 0, 1]),
    [this._orientation_q[0], -this._orientation_q[1],
    -this._orientation_q[2], -this._orientation_q[3]]);
  this._forward = [forward[1], forward[2], forward[3]];
}

/**
 * Set source's velocity (in meters/second).
 * @param {Number} x
 * @param {Number} y
 * @param {Number} z
 */
Source.prototype.setVelocity = function(x, y, z) {
  //TODO(bitllama) Make velocity/doppler thing here.
}

/**
 * Set source's directivity (rolloff factor based on angle).
 * @param {Number} alpha
 * Determines directivity pattern (0 to 1), where 0 is an omnidirectional
 * pattern, 1 is a bidirectional pattern, 0.5 is a cardiod pattern.
 * @param {Number} order
 * Determines the steepness of the directivity pattern (1 to Inf).
 */
Source.prototype.setDirectivity = function(alpha, order) {
  // Clamp between 0 and 1.
  this._directivity_alpha = Math.min(1, Math.max(0, alpha));

  // Clamp between 1 and Inf.
  this._directivity_order = Math.min(1, order);
}

// Convert roll/pitch/yaw (in radians) to quaternion.
function toQuaternion(roll, pitch, yaw) {
  var t0 = Math.cos(yaw * 0.5);
  var t1 = Math.sin(yaw * 0.5);
  var t2 = Math.cos(roll * 0.5);
  var t3 = Math.sin(roll * 0.5);
  var t4 = Math.cos(pitch * 0.5);
  var t5 = Math.sin(pitch * 0.5);
  return [
    t0 * t2 * t4 + t1 * t3 * t5,
    t0 * t3 * t4 - t1 * t2 * t5,
    t0 * t2 * t5 + t1 * t3 * t4,
    t1 * t2 * t4 - t0 * t3 * t5
  ];
}

// Compute Hamilton product of two quaternions.
function hamiltonProduct(q1, q2) {
  return [
    q1[0] * q2[0] - q1[1] * q2[1] - q1[2] * q2[2] - q1[3] * q2[3],
    q1[0] * q2[1] + q1[1] * q2[0] + q1[2] * q2[3] - q1[3] * q2[2],
    q1[0] * q2[2] - q1[1] * q2[3] + q1[2] * q2[0] + q1[3] * q2[1],
    q1[0] * q2[3] + q1[1] * q2[2] - q1[2] * q2[1] + q1[3] * q2[0]
  ];
}

function computeDirectivity(forward, direction_to_listener, alpha, order) {
  if (alpha < Globals.EpsilonFloat) {
    return 1.0;
  }
  var cosTheta = forward[0] * direction_to_listener[0] +
    forward[1] * direction_to_listener[1] +
    forward[2] * direction_to_listener[2];
  var gain = (1 - alpha) + alpha * cosTheta;

  //TODO(bitllama): This ignores phase. Consider re-introducing.
  return Math.pow(Math.abs(gain), order);
}

module.exports = Source;