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

    // ── Transformation band: synced odometers (problem → outcome) ──
    const tFrom = document.querySelector('.transform-from .transform-list');
    const tTo = document.querySelector('.transform-to .transform-list');
    if (tFrom && tTo && !tFrom.dataset.init) {
        tFrom.dataset.init = tTo.dataset.init = '1';
        const lists = [tFrom, tTo];

        if (reducedMotion) {
            // static: hide the animated packet + wire, leave the first pair showing
            document.querySelectorAll('.transform-packet, .transform-wire')
                .forEach(el => { el.style.display = 'none'; });
        } else if (tFrom.children.length > 1) {
            const real = tFrom.children.length; // real rows, counted before cloning
            // duplicate the first row of each list so the wrap is seamless
            lists.forEach(list => list.appendChild(list.children[0].cloneNode(true)));

            const STEP = 1.55;  // em per row — must match CSS li height
            const SLIDE = 700;  // ms — must match CSS transition duration
            let i = 0;

            const advance = () => {
                i++;
                lists.forEach(list => {
                    list.style.transition = '';
                    list.style.transform = `translateY(-${i * STEP}em)`;
                });
                if (i >= real) {
                    // landed on the cloned first row: snap back invisibly
                    setTimeout(() => {
                        lists.forEach(list => {
                            list.style.transition = 'none';
                            list.style.transform = 'translateY(0)';
                        });
                        void tFrom.offsetHeight; // force reflow
                        lists.forEach(list => { list.style.transition = ''; });
                        i = 0;
                    }, SLIDE + 40);
                }
            };

            setInterval(advance, 3000);
        }
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
