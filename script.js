document.addEventListener('DOMContentLoaded', () => {
    // Nav Scroll Effect
    const navbar = document.querySelector('.navbar');
    
    window.addEventListener('scroll', () => {
        if (window.scrollY > 50) {
            navbar.classList.add('scrolled');
        } else {
            navbar.classList.remove('scrolled');
        }
    });

    // Mobile Menu Toggle
    const menuToggle = document.querySelector('.menu-toggle');
    const navLinks = document.querySelector('.nav-links');

    if(menuToggle) {
        menuToggle.addEventListener('click', () => {
            navLinks.classList.toggle('active');
            navbar.classList.toggle('menu-open');
            
            // Transform hamburger to X
            const spans = menuToggle.querySelectorAll('span');
            if (navLinks.classList.contains('active')) {
                spans[0].style.transform = 'rotate(45deg) translate(5px, 5px)';
                spans[1].style.opacity = '0';
                spans[2].style.transform = 'rotate(-45deg) translate(7px, -7px)';
            } else {
                spans[0].style.transform = 'none';
                spans[1].style.opacity = '1';
                spans[2].style.transform = 'none';
            }
        });
    }

    // Folio Carousel Layout Logic
    const carouselContainer = document.getElementById('folioCarousel');
    if (carouselContainer) {
        const cards = Array.from(carouselContainer.querySelectorAll('.carousel-card'));
        const navContainer = document.getElementById('carouselNav');
        let activeIndex = Math.floor(cards.length / 2);

        // Build navigation dots
        cards.forEach((_, i) => {
            const dot = document.createElement('div');
            dot.classList.add('carousel-dot');
            if (i === activeIndex) dot.classList.add('active');
            dot.addEventListener('click', () => {
                activeIndex = i;
                updateCarousel();
            });
            navContainer.appendChild(dot);
        });

        const dots = navContainer.querySelectorAll('.carousel-dot');

        function updateCarousel() {
            cards.forEach((card, index) => {
                let offset = index - activeIndex;
                let absOffset = Math.abs(offset);
                
                // Hide cards too far out
                if (absOffset > 3) {
                    card.style.opacity = '0';
                    card.style.visibility = 'hidden';
                    card.style.pointerEvents = 'none';
                    return;
                }
                
                card.style.visibility = 'visible';
                card.style.pointerEvents = 'auto';
                
                let scale = 1;
                let translateX = 0;
                let translateY = 0;
                let zIndex = 10;
                let opacity = 1;
                let filter = 'none';
                
                if (offset !== 0) {
                    let direction = Math.sign(offset);
                    if (absOffset === 1) {
                        scale = 0.85;
                        translateX = direction * 280;
                        translateY = 80;
                        zIndex = 5;
                        opacity = 0.5;
                        // Restrained aesthetic: washed out slightly rather than full blur
                        filter = 'grayscale(80%) contrast(0.8)';
                    } else if (absOffset === 2) {
                        scale = 0.7;
                        translateX = direction * 460;
                        translateY = 180;
                        zIndex = 2;
                        opacity = 0.2;
                        filter = 'grayscale(100%) blur(1px) contrast(0.6)';
                    } else if (absOffset === 3) {
                        scale = 0.55;
                        translateX = direction * 600;
                        translateY = 280;
                        zIndex = 1;
                        opacity = 0.05;
                        filter = 'grayscale(100%) blur(3px) contrast(0.4)';
                    }
                }
                
                // Manage Active Class
                if (offset === 0) {
                    card.classList.add('active');
                } else {
                    card.classList.remove('active');
                }
                
                // Responsive spacing
                if (window.innerWidth <= 900 && offset !== 0) {
                   translateX = direction * (absOffset === 1 ? 160 : (absOffset === 2 ? 260 : 340));
                   translateY = absOffset === 1 ? 60 : (absOffset === 2 ? 120 : 180);
                }

                card.style.zIndex = zIndex;
                card.style.opacity = opacity;
                card.style.filter = filter;
                card.style.transform = `translate(calc(-50% + ${translateX}px), calc(-50% + ${translateY}px)) scale(${scale})`;
            });

            // Update dots
            dots.forEach((d, i) => d.classList.toggle('active', i === activeIndex));
        }

        // Initialize positions
        cards.forEach((card, i) => {
            card.addEventListener('click', () => {
                activeIndex = i;
                updateCarousel();
            });
            card.addEventListener('mouseenter', () => {
                activeIndex = i;
                updateCarousel();
            });
        });

        window.addEventListener('resize', updateCarousel);
        updateCarousel();
    }

    // Scroll Animation (Intersection Observer)
    const observerOptions = {
        root: null,
        rootMargin: '0px',
        threshold: 0.15
    };

    const observer = new IntersectionObserver((entries, observer) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                entry.target.classList.add('visible');
                // Don't unobserve to allow re-animation or keep it observed
                observer.unobserve(entry.target); 
            }
        });
    }, observerOptions);

    // Select all elements to animate
    const animateElements = document.querySelectorAll('.text-content, .reveal-on-scroll');
    animateElements.forEach(el => observer.observe(el));
    
    // Initial trigger for hero items that are already in view
    setTimeout(() => {
        document.querySelectorAll('.hero .text-content').forEach(el => {
            el.classList.add('visible');
        });
    }, 100);

    // Hero Subtitle Orb Tracking
    const subtitleBox = document.getElementById('heroSubtitle');
    if (subtitleBox) {
        const orb = subtitleBox.querySelector('.blue-orb');
        if (orb) {
            subtitleBox.addEventListener('mousemove', (e) => {
                const rect = subtitleBox.getBoundingClientRect();
                const x = e.clientX - rect.left;
                const y = e.clientY - rect.top;
                orb.style.left = `${x}px`;
                orb.style.top = `${y}px`;
            });
            
            subtitleBox.addEventListener('mouseleave', () => {
                orb.style.left = '50%';
                orb.style.top = '50%';
            });
        }
    }

    // Custom Folio SVG spiral drawing logic
    const folioSection = document.getElementById('folio-editorial');
    const spiralSvg = document.querySelector('.spiral-svg');
    if (folioSection && spiralSvg) {
        const svgObserver = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    spiralSvg.classList.add('drawn');
                    // wait for animation to complete (2.5s) then dissolve
                    setTimeout(() => {
                        spiralSvg.classList.add('dissolve');
                    }, 2500);
                    svgObserver.unobserve(entry.target);
                }
            });
        }, { threshold: 0.3 });
        svgObserver.observe(folioSection);
    }

    // Global Glow Mouse Cursor & Trail
    const globalGlow = document.createElement('div');
    globalGlow.classList.add('global-glow-cursor');
    document.body.appendChild(globalGlow);

    let lastTrailTime = 0;
    document.addEventListener('mousemove', (e) => {
        globalGlow.style.left = e.clientX + 'px';
        globalGlow.style.top = e.clientY + 'px';

        const now = Date.now();
        if (now - lastTrailTime > 50) { // Limit trail spawn rate for performance
            lastTrailTime = now;
            const trail = document.createElement('div');
            trail.classList.add('glow-trail');
            trail.style.left = e.clientX + 'px';
            trail.style.top = e.clientY + 'px';
            document.body.appendChild(trail);

            // Trigger reflow to ensure CSS processes the initial state before transitioning
            void trail.offsetWidth;
            
            trail.style.opacity = '0';
            trail.style.transform = 'translate(-50%, -50%) scale(0.2)';
            
            setTimeout(() => {
                trail.remove();
            }, 800);
        }
    });

    // Make glow burst on click
    document.addEventListener('click', () => {
        globalGlow.style.transform = 'translate(-50%, -50%) scale(1.5)';
        setTimeout(() => {
            globalGlow.style.transform = 'translate(-50%, -50%) scale(1)';
        }, 300);
    });
});
