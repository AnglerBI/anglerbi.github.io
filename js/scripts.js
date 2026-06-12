// ══════════════════════════════════════════════════════
// Angler BI — scripts.js
// ══════════════════════════════════════════════════════

document.addEventListener('DOMContentLoaded', () => {

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    // ── Footer year ──────────────────────────────────
    const yrEl = document.getElementById('currentYear');
    if (yrEl) yrEl.textContent = new Date().getFullYear();

    // ── Navbar: add .scrolled class on scroll ────────
    const nav = document.getElementById('mainNav');
    if (nav) {
        const handleScroll = () => nav.classList.toggle('scrolled', window.scrollY > 20);
        window.addEventListener('scroll', handleScroll, { passive: true });
        handleScroll();
    }

    // ── Mobile menu toggle ───────────────────────────
    const toggle = document.getElementById('navToggle');
    const mobileMenu = document.getElementById('mobileMenu');
    if (toggle && mobileMenu) {
        toggle.addEventListener('click', () => {
            const isOpen = mobileMenu.classList.toggle('open');
            toggle.classList.toggle('open', isOpen);
            document.body.style.overflow = isOpen ? 'hidden' : '';
        });

        mobileMenu.querySelectorAll('a').forEach(link =>
            link.addEventListener('click', () => {
                mobileMenu.classList.remove('open');
                toggle.classList.remove('open');
                document.body.style.overflow = '';
            })
        );
    }

    // ── Scroll reveal via IntersectionObserver ───────
    const revealEls = document.querySelectorAll('.reveal');
    if (revealEls.length) {
        const observer = new IntersectionObserver(entries => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    entry.target.classList.add('visible');
                    observer.unobserve(entry.target);
                }
            });
        }, { threshold: 0.12 });
        revealEls.forEach(el => observer.observe(el));
    }

    // ── Count-up stats ───────────────────────────────
    // <span data-count="12.9" data-decimals="1" data-prefix="$" data-suffix="M">
    const counters = document.querySelectorAll('[data-count]');
    if (counters.length) {
        const fmt = (el, value) => {
            const decimals = parseInt(el.dataset.decimals || '0', 10);
            el.textContent =
                (el.dataset.prefix || '') + value.toFixed(decimals) + (el.dataset.suffix || '');
        };

        const runCount = el => {
            const target = parseFloat(el.dataset.count);
            if (reducedMotion) {
                fmt(el, target);
                return;
            }
            const duration = 1600;
            const start = performance.now();
            const tick = now => {
                const t = Math.min((now - start) / duration, 1);
                const eased = 1 - Math.pow(1 - t, 4);
                fmt(el, target * eased);
                if (t < 1) requestAnimationFrame(tick);
            };
            requestAnimationFrame(tick);
        };

        const countObserver = new IntersectionObserver(entries => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    runCount(entry.target);
                    countObserver.unobserve(entry.target);
                }
            });
        }, { threshold: 0.5 });
        counters.forEach(el => countObserver.observe(el));
    }

    // ── Marquee: duplicate track content for a seamless loop ──
    const marqueeTrack = document.getElementById('marqueeTrack');
    if (marqueeTrack) {
        marqueeTrack.innerHTML += marqueeTrack.innerHTML;
    }

    // ── Hero Lottie animation ────────────────────────
    const lottieEl = document.getElementById('heroLottie');
    if (lottieEl && window.lottie) {
        const anim = window.lottie.loadAnimation({
            container: lottieEl,
            renderer: 'svg',
            loop: true,
            autoplay: !reducedMotion,
            path: '/assets/hero-flow.json'
        });
        if (reducedMotion) {
            anim.addEventListener('DOMLoaded', () => anim.goToAndStop(90, true));
        }
    }
});
