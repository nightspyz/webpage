const canvas = document.getElementById('simulationCanvas');
const ctx = canvas.getContext('2d');

const gravity = 0.2;
const wind = 0.05;
const particleInterval = 500; // Time interval between new particles, in milliseconds

class Particle {
  constructor(x, y, radius, dx, dy, color) {
    this.x = x;
    this.y = y;
    this.radius = radius;
    this.dx = dx;
    this.dy = dy;
    this.color = color;
  }

  draw() {
    ctx.beginPath();
    ctx.arc(this.x, this.y, this.radius, 0, Math.PI * 2);
    ctx.fillStyle = this.color;
    ctx.fill();
    ctx.closePath();
  }

  update() {
    this.dy += gravity;
    this.dx += wind;
    this.x += this.dx;
    this.y += this.dy;

    if (this.x + this.radius > canvas.width || this.x - this.radius < 0) {
      this.dx = -this.dx;
    }
    if (this.y + this.radius > canvas.height || this.y - this.radius < 0) {
      this.dy = -this.dy * 0.9;
    }
  }
}

function random(min, max) {
  return Math.random() * (max - min) + min;
}

function randomColor() {
  const colors = ['red', 'blue', 'green', 'yellow', 'orange', 'purple', 'pink'];
  return colors[Math.floor(Math.random() * colors.length)];
}

const particles = [];

function createParticle() {
  const radius = random(5, 20);
  const x = random(radius, canvas.width - radius);
  const y = random(radius, canvas.height - radius);
  const dx = random(-3, 3);
  const dy = random(-3, 3);
  const color = randomColor();

  particles.push(new Particle(x, y, radius, dx, dy, color));
}

function clearCanvas() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}

function animate() {
  clearCanvas();

  particles.forEach((particle) => {
    particle.draw();
    particle.update();
  });

  requestAnimationFrame(animate);
}

createParticle(); // Create the first particle
animate();

setInterval(createParticle, particleInterval); // Continuously add new particles
