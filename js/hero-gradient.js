/* ══════════════════════════════════════════════════════
   Angler BI — hero-gradient.js
   Self-hosted animated mesh gradient (Stripe-style).
   A full-quad WebGL fragment shader blends four brand
   colours through layered, domain-warped simplex noise to
   give a slow, silky, liquid drift. No external library.

   Colours are read from CSS custom properties on the canvas
   (--gradient-color-1..4) so the palette lives in styles.css.
   Falls back to the canvas' CSS background where WebGL is
   unavailable; reduced-motion is handled by the caller.
══════════════════════════════════════════════════════ */
(function () {
    'use strict';

    var VERT = [
        'attribute vec2 a_pos;',
        'varying vec2 v_uv;',
        'void main(){',
        '  v_uv = a_pos * 0.5 + 0.5;',
        '  gl_Position = vec4(a_pos, 0.0, 1.0);',
        '}'
    ].join('\n');

    var FRAG = [
        'precision highp float;',
        'varying vec2 v_uv;',
        'uniform float u_time;',
        'uniform vec2 u_res;',
        'uniform vec3 u_color1;',
        'uniform vec3 u_color2;',
        'uniform vec3 u_color3;',
        'uniform vec3 u_color4;',

        // Ashima / Stefan Gustavson simplex noise (webgl-noise, MIT)
        'vec4 permute(vec4 x){return mod(((x*34.0)+1.0)*x,289.0);}',
        'vec4 taylorInvSqrt(vec4 r){return 1.79284291400159 - 0.85373472095314 * r;}',
        'float snoise(vec3 v){',
        '  const vec2 C = vec2(1.0/6.0, 1.0/3.0);',
        '  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);',
        '  vec3 i  = floor(v + dot(v, C.yyy));',
        '  vec3 x0 = v - i + dot(i, C.xxx);',
        '  vec3 g = step(x0.yzx, x0.xyz);',
        '  vec3 l = 1.0 - g;',
        '  vec3 i1 = min(g.xyz, l.zxy);',
        '  vec3 i2 = max(g.xyz, l.zxy);',
        '  vec3 x1 = x0 - i1 + 1.0 * C.xxx;',
        '  vec3 x2 = x0 - i2 + 2.0 * C.xxx;',
        '  vec3 x3 = x0 - 1.0 + 3.0 * C.xxx;',
        '  i = mod(i, 289.0);',
        '  vec4 p = permute(permute(permute(',
        '            i.z + vec4(0.0, i1.z, i2.z, 1.0))',
        '          + i.y + vec4(0.0, i1.y, i2.y, 1.0))',
        '          + i.x + vec4(0.0, i1.x, i2.x, 1.0));',
        '  float n_ = 1.0/7.0;',
        '  vec3 ns = n_ * D.wyz - D.xzx;',
        '  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);',
        '  vec4 x_ = floor(j * ns.z);',
        '  vec4 y_ = floor(j - 7.0 * x_);',
        '  vec4 x = x_ * ns.x + ns.yyyy;',
        '  vec4 y = y_ * ns.x + ns.yyyy;',
        '  vec4 h = 1.0 - abs(x) - abs(y);',
        '  vec4 b0 = vec4(x.xy, y.xy);',
        '  vec4 b1 = vec4(x.zw, y.zw);',
        '  vec4 s0 = floor(b0) * 2.0 + 1.0;',
        '  vec4 s1 = floor(b1) * 2.0 + 1.0;',
        '  vec4 sh = -step(h, vec4(0.0));',
        '  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;',
        '  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;',
        '  vec3 p0 = vec3(a0.xy, h.x);',
        '  vec3 p1 = vec3(a0.zw, h.y);',
        '  vec3 p2 = vec3(a1.xy, h.z);',
        '  vec3 p3 = vec3(a1.zw, h.w);',
        '  vec4 norm = taylorInvSqrt(vec4(dot(p0,p0), dot(p1,p1), dot(p2,p2), dot(p3,p3)));',
        '  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;',
        '  vec4 m = max(0.6 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);',
        '  m = m * m;',
        '  return 42.0 * dot(m*m, vec4(dot(p0,x0), dot(p1,x1), dot(p2,x2), dot(p3,x3)));',
        '}',

        'void main(){',
        '  vec2 uv = v_uv;',
        '  float aspect = u_res.x / max(u_res.y, 1.0);',
        '  vec2 p = vec2(uv.x * aspect, uv.y);',
        '  float t = u_time;',

        // Steeper diagonal so bands sweep top-right -> bottom-left like Stripe
        '  float a = -0.62;',
        '  mat2 R = mat2(cos(a), -sin(a), sin(a), cos(a));',
        '  vec2 q = R * p;',

        // Level-1 domain warp: large organic S-curves (big amplitude, low freq)
        '  vec2 w1 = vec2(',
        '    snoise(vec3(q * 0.28 + vec2(0.0,  t * 0.08), 1.7)),',
        '    snoise(vec3(q * 0.28 + vec2(t * 0.07, 0.0),  4.3))',
        '  ) * 0.85;',
        '  vec2 qq = q + w1;',

        // Level-2 warp: smaller detail curl layered on top
        '  vec2 w2 = vec2(',
        '    snoise(vec3(qq * 0.55 + vec2(7.1, t * 0.06), 7.3)),',
        '    snoise(vec3(qq * 0.55 + vec2(t * 0.05, 3.0), 2.1))',
        '  ) * 0.38;',
        '  vec2 qqq = qq + w2;',

        // Three large-scale ribbon fields — low freq = wide sweeping bands
        '  float n2 = snoise(vec3(qqq * 0.48,        t * 0.07 + 10.0));',
        '  float n3 = snoise(vec3(qqq * 0.38 + 5.0,  t * 0.09 + 30.0));',
        '  float n4 = snoise(vec3(qqq * 0.32 + 9.0,  t * 0.06 + 60.0));',

        '  vec3 col = u_color1;',
        // Narrow smoothstep -> sharper band boundaries (more Stripe-like ribbon edges)
        '  col = mix(col, u_color2, smoothstep(-0.22, 0.28, n2));',
        '  col = mix(col, u_color3, smoothstep(-0.18, 0.32, n3) * 0.93);',
        '  col = mix(col, u_color4, smoothstep(-0.12, 0.50, n4) * 0.90);',

        // Primary silk fiber layer — runs along the diagonal sweep direction
        // High amplitude (0.24) so strands are clearly visible like Stripe
        '  float fp1 = (q.x * 0.90 + q.y * 0.25) * 68.0',
        '            + (w1.x - w1.y) * 11.0',
        '            + snoise(vec3(qqq * 0.38, t * 0.04)) * 4.5;',
        '  float fib1 = 0.5 + 0.5 * sin(fp1 * 6.2831853);',
        '  fib1 = pow(fib1, 1.8);',   // wider strands (Stripe strands are broad, not hairlines)
        '  col += fib1 * 0.28;',       // bright strand peaks — clearly visible
        '  col -= (1.0 - fib1) * 0.11;', // deeper dark troughs = high contrast

        // Secondary finer layer — half wavelength, adds sub-strand texture
        '  float fp2 = (q.x * 0.90 + q.y * 0.25) * 136.0',
        '            + (w1.x - w1.y) * 11.0',
        '            + snoise(vec3(qqq * 0.38, t * 0.04 + 50.0)) * 4.5;',
        '  float fib2 = 0.5 + 0.5 * sin(fp2 * 6.2831853);',
        '  fib2 = pow(fib2, 3.2);',
        '  col += fib2 * 0.07;',

        // Luminance highlights where ribbons peak (like Stripe white-ish hot spots)
        '  float glow = smoothstep(0.30, 1.0, snoise(vec3(qqq * 0.42 + 40.0, t * 0.05)));',
        '  col += glow * vec3(0.10, 0.12, 0.20);',

        '  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);',
        '}'
    ].join('\n');

    function hexToRgb(hex) {
        hex = (hex || '').trim().replace('#', '');
        if (hex.length === 3) {
            hex = hex.charAt(0) + hex.charAt(0) + hex.charAt(1) + hex.charAt(1) + hex.charAt(2) + hex.charAt(2);
        }
        var int = parseInt(hex, 16);
        if (isNaN(int)) { return [0.03, 0.76, 0.91]; }
        return [((int >> 16) & 255) / 255, ((int >> 8) & 255) / 255, (int & 255) / 255];
    }

    function compile(gl, type, src) {
        var s = gl.createShader(type);
        gl.shaderSource(s, src);
        gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
            console.error('hero-gradient: shader compile failed —', gl.getShaderInfoLog(s));
            gl.deleteShader(s);
            return null;
        }
        return s;
    }

    function Gradient() {
        this.playing = false;
        this.raf = null;
    }

    Gradient.prototype.initGradient = function (selector) {
        var canvas = typeof selector === 'string' ? document.querySelector(selector) : selector;
        if (!canvas) { return this; }
        this.canvas = canvas;

        var opts = { antialias: true, alpha: true, premultipliedAlpha: false, powerPreference: 'low-power' };
        var gl = canvas.getContext('webgl', opts) || canvas.getContext('experimental-webgl', opts);
        if (!gl) { canvas.classList.add('is-static'); return this; }
        this.gl = gl;

        var vs = compile(gl, gl.VERTEX_SHADER, VERT);
        var fs = compile(gl, gl.FRAGMENT_SHADER, FRAG);
        if (!vs || !fs) { canvas.classList.add('is-static'); return this; }

        var prog = gl.createProgram();
        gl.attachShader(prog, vs);
        gl.attachShader(prog, fs);
        gl.linkProgram(prog);
        if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
            console.error('hero-gradient: program link failed —', gl.getProgramInfoLog(prog));
            canvas.classList.add('is-static');
            return this;
        }
        gl.useProgram(prog);
        this.prog = prog;

        // full-screen triangle
        var buf = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
        var loc = gl.getAttribLocation(prog, 'a_pos');
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

        this.uTime = gl.getUniformLocation(prog, 'u_time');
        this.uRes = gl.getUniformLocation(prog, 'u_res');

        var cs = getComputedStyle(canvas);
        ['u_color1', 'u_color2', 'u_color3', 'u_color4'].forEach(function (name, idx) {
            var raw = cs.getPropertyValue('--gradient-color-' + (idx + 1));
            gl.uniform3fv(gl.getUniformLocation(prog, name), hexToRgb(raw));
        });

        this.resize();
        var self = this;
        if (window.ResizeObserver) {
            this.ro = new ResizeObserver(function () { self.resize(); });
            this.ro.observe(canvas);
        } else {
            this.onResize = function () { self.resize(); };
            window.addEventListener('resize', this.onResize);
        }

        // pause while scrolled out of view to save battery
        if (window.IntersectionObserver) {
            this.io = new IntersectionObserver(function (entries) {
                if (entries[0].isIntersecting) { self.play(); } else { self.pause(); }
            }, { threshold: 0 });
            this.io.observe(canvas);
        }

        this.t0 = performance.now();
        this.play();
        return this;
    };

    Gradient.prototype.resize = function () {
        if (!this.gl) { return; }
        var canvas = this.canvas;
        var dpr = Math.min(window.devicePixelRatio || 1, 2);
        var w = Math.max(1, Math.floor(canvas.clientWidth * dpr));
        var h = Math.max(1, Math.floor(canvas.clientHeight * dpr));
        if (canvas.width !== w || canvas.height !== h) {
            canvas.width = w;
            canvas.height = h;
        }
        this.gl.viewport(0, 0, w, h);
        this.gl.uniform2f(this.uRes, w, h);
        if (!this.playing) { this.drawFrame(performance.now()); }
    };

    Gradient.prototype.drawFrame = function (now) {
        var gl = this.gl;
        gl.uniform1f(this.uTime, (now - this.t0) / 1000);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
    };

    Gradient.prototype.loop = function (now) {
        if (!this.playing) { return; }
        this.drawFrame(now);
        var self = this;
        this.raf = requestAnimationFrame(function (n) { self.loop(n); });
    };

    Gradient.prototype.play = function () {
        if (this.playing || !this.gl) { return; }
        this.playing = true;
        var self = this;
        this.raf = requestAnimationFrame(function (n) { self.loop(n); });
    };

    Gradient.prototype.pause = function () {
        this.playing = false;
        if (this.raf) { cancelAnimationFrame(this.raf); this.raf = null; }
    };

    window.Gradient = Gradient;
})();
