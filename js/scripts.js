// ══════════════════════════════════════════════════════
// Angler BI — scripts.js
// ══════════════════════════════════════════════════════

document.addEventListener('DOMContentLoaded', () => {

    // ── Footer year ──────────────────────────────────
    const yrEl = document.getElementById('currentYear');
    if (yrEl) yrEl.textContent = new Date().getFullYear();

    // ── Navbar: add .scrolled class on scroll ────────
    const nav = document.getElementById('mainNav');
    const handleScroll = () => nav.classList.toggle('scrolled', window.scrollY > 20);
    window.addEventListener('scroll', handleScroll, { passive: true });
    handleScroll();

    // ── Mobile menu toggle ───────────────────────────
    const toggle     = document.getElementById('navToggle');
    const mobileMenu = document.getElementById('mobileMenu');

    toggle.addEventListener('click', () => {
        const isOpen = mobileMenu.classList.toggle('open');
        toggle.classList.toggle('open', isOpen);
        document.body.style.overflow = isOpen ? 'hidden' : '';
    });

    document.querySelectorAll('.mobile-menu a').forEach(link =>
        link.addEventListener('click', () => {
            mobileMenu.classList.remove('open');
            toggle.classList.remove('open');
            document.body.style.overflow = '';
        })
    );

    // ── Scroll reveal via IntersectionObserver ───────
    const revealEls = document.querySelectorAll('.reveal');
    const observer  = new IntersectionObserver(entries => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                entry.target.classList.add('visible');
                observer.unobserve(entry.target);
            }
        });
    }, { threshold: 0.12 });
    revealEls.forEach(el => observer.observe(el));

    // ── Hero canvas: animated data-network ───────────
    const canvas = document.getElementById('heroCanvas');
    if (!canvas) return;

    const ctx        = canvas.getContext('2d');
    const NODE_COUNT = 55;
    const MAX_DIST   = 175;
    const ACCENT_RGB = [7, 195, 232];

    let W, H, nodes, animFrame;

    function initNodes() {
        nodes = Array.from({ length: NODE_COUNT }, () => ({
            x:  Math.random() * W,
            y:  Math.random() * H,
            vx: (Math.random() - 0.5) * 0.38,
            vy: (Math.random() - 0.5) * 0.38,
            r:  Math.random() * 1.4 + 0.5,
        }));
    }

    function resize() {
        const hero = document.getElementById('hero');
        W = canvas.width  = hero.offsetWidth;
        H = canvas.height = hero.offsetHeight;
        initNodes();
    }

    function draw() {
        ctx.clearRect(0, 0, W, H);
        const [r, g, b] = ACCENT_RGB;

        for (let i = 0; i < nodes.length; i++) {
            const a = nodes[i];
            a.x += a.vx;
            a.y += a.vy;
            if (a.x < 0 || a.x > W) a.vx *= -1;
            if (a.y < 0 || a.y > H) a.vy *= -1;

            for (let j = i + 1; j < nodes.length; j++) {
                const bn = nodes[j];
                const dx   = a.x - bn.x;
                const dy   = a.y - bn.y;
                const dist = Math.sqrt(dx * dx + dy * dy);
                if (dist < MAX_DIST) {
                    const alpha = (1 - dist / MAX_DIST) * 0.16;
                    ctx.strokeStyle = `rgba(${r},${g},${b},${alpha})`;
                    ctx.lineWidth   = 0.75;
                    ctx.beginPath();
                    ctx.moveTo(a.x, a.y);
                    ctx.lineTo(bn.x, bn.y);
                    ctx.stroke();
                }
            }

            ctx.fillStyle = `rgba(${r},${g},${b},0.32)`;
            ctx.beginPath();
            ctx.arc(a.x, a.y, a.r, 0, Math.PI * 2);
            ctx.fill();
        }

        animFrame = requestAnimationFrame(draw);
    }

    // Use ResizeObserver so canvas stays in sync with the hero height
    const ro = new ResizeObserver(() => {
        cancelAnimationFrame(animFrame);
        resize();
        draw();
    });
    ro.observe(document.getElementById('hero'));
    resize();
    draw();
});
