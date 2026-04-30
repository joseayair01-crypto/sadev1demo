/**
 * ============================================================
 * ARCHIVO: js/btn-flotante-animator.js
 * DESCRIPCIÓN: Animaciones periódicas para el botón flotante de comprobante
 * Aplica latidos y vibraciones para llamar la atención del usuario
 * ============================================================
 */

(function() {
    'use strict';

    // Configuración de animaciones
    const CONFIG = {
        HEARTBEAT_INTERVAL: 6000,  // 6 segundos entre latidos
        VIBRATE_INTERVAL: 12000,   // 12 segundos entre vibraciones
        ANIMATION_DURATION: 800,   // Duración de cada animación en ms
        SELECTOR: '.btn-flotante-comprobante'
    };

    // Estado
    let animationTimeouts = {
        heartbeat: null,
        vibrate: null
    };
    let missingButtonLogged = false;

    function reduceMotionActiva() {
        return typeof window.matchMedia === 'function'
            && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    }

    function ahorroDatosActivo() {
        return !!(navigator.connection && navigator.connection.saveData);
    }

    function debeAnimar() {
        return !reduceMotionActiva()
            && !ahorroDatosActivo()
            && !document.hidden;
    }

    /**
     * Remover todas las clases de animación
     * @param {HTMLElement} button - Elemento del botón
     */
    function removeAnimationClasses(button) {
        if (!button) return;
        button.classList.remove('animate-heartbeat', 'animate-vibrate');
    }

    /**
     * Aplicar animación de latido
     * @param {HTMLElement} button - Elemento del botón
     */
    function applyHeartbeat(button) {
        if (!button) return;
        
        removeAnimationClasses(button);
        
        // Forzar reflow para reiniciar la animación
        void button.offsetWidth;
        
        button.classList.add('animate-heartbeat');
        
        console.log('💓 Latido aplicado al botón flotante');
    }

    /**
     * Aplicar animación de vibración
     * @param {HTMLElement} button - Elemento del botón
     */
    function applyVibrate(button) {
        if (!button) return;
        
        removeAnimationClasses(button);
        
        // Forzar reflow para reiniciar la animación
        void button.offsetWidth;
        
        button.classList.add('animate-vibrate');
        
        console.log('📳 Vibración aplicada al botón flotante');
    }

    /**
     * Limpiar todos los timeouts pendientes
     */
    function clearAllAnimations() {
        if (animationTimeouts.heartbeat) {
            clearInterval(animationTimeouts.heartbeat);
            animationTimeouts.heartbeat = null;
        }
        if (animationTimeouts.vibrate) {
            clearInterval(animationTimeouts.vibrate);
            animationTimeouts.vibrate = null;
        }
    }

    /**
     * Iniciar animaciones periódicas
     */
    function startAnimations() {
        const button = document.querySelector(CONFIG.SELECTOR);
        if (!button) {
            if (!missingButtonLogged) {
                console.warn(`⚠️  [Animator] Botón ${CONFIG.SELECTOR} no encontrado`);
                missingButtonLogged = true;
            }
            return;
        }

        missingButtonLogged = false;

        if (!debeAnimar()) {
            removeAnimationClasses(button);
            console.log('ℹ️ [Animator] Animaciones omitidas por contexto de rendimiento o accesibilidad');
            return;
        }

        console.log('🎬 [Animator] Iniciando animaciones periódicas del botón flotante');

        // Latido periódico
        animationTimeouts.heartbeat = setInterval(() => {
            applyHeartbeat(button);
        }, CONFIG.HEARTBEAT_INTERVAL);

        // Vibración periódica (alternada con latido)
        animationTimeouts.vibrate = setInterval(() => {
            applyVibrate(button);
        }, CONFIG.VIBRATE_INTERVAL);

        // Primer latido inmediato después de 2 segundos
        setTimeout(() => {
            applyHeartbeat(button);
        }, 2000);
    }

    /**
     * Detener y limpiar animaciones
     */
    function stopAnimations() {
        clearAllAnimations();
        const button = document.querySelector(CONFIG.SELECTOR);
        if (button) {
            removeAnimationClasses(button);
        }
        console.log('🛑 [Animator] Animaciones detenidas');
    }

    /**
     * Event listeners para pausar cuando hay modales abiertos
     */
    function setupModalListeners() {
        // Pausar animaciones cuando se abre un modal
        document.addEventListener('openModal', () => {
            stopAnimations();
        });

        // Reanudar animaciones cuando se cierra un modal
        document.addEventListener('closeModal', () => {
            setTimeout(startAnimations, 500);
        });

        document.addEventListener('visibilitychange', () => {
            if (document.hidden) {
                stopAnimations();
                return;
            }

            if (!animationTimeouts.heartbeat) {
                startAnimations();
            }
        });

        // Escuchar cambios en visibilidad del botón (por CSS)
        const button = document.querySelector(CONFIG.SELECTOR);
        if (button) {
            const observer = new MutationObserver((mutations) => {
                mutations.forEach((mutation) => {
                    if (mutation.attributeName === 'style') {
                        const isVisible = window.getComputedStyle(button).opacity !== '0';
                        if (!isVisible) {
                            stopAnimations();
                        } else if (!animationTimeouts.heartbeat) {
                            startAnimations();
                        }
                    }
                });
            });

            observer.observe(button, { attributes: true, attributeFilter: ['style'] });
        }
    }

    /**
     * Lógica para el botón expansible de 2 clics en móviles
     */
    function setupExpandableInteraction() {
        const button = document.querySelector(CONFIG.SELECTOR);
        if (!button) return;

        let expandTimeout = null;

        button.addEventListener('click', function(e) {
            // Solo aplicar lógica de 2 clics en pantallas móviles (max-width: 768px)
            if (window.innerWidth <= 768) {
                const isExpanded = button.classList.contains('is-expanded');
                
                if (!isExpanded) {
                    // Primer clic: Prevenir navegación y expandir
                    e.preventDefault();
                    button.classList.add('is-expanded');
                    
                    // Auto-encoger después de 5 segundos si no da el segundo clic
                    if (expandTimeout) clearTimeout(expandTimeout);
                    expandTimeout = setTimeout(() => {
                        button.classList.remove('is-expanded');
                    }, 5000);
                } else {
                    // Segundo clic: Permitir navegación normal (limpiar timeout)
                    if (expandTimeout) clearTimeout(expandTimeout);
                }
            }
        });

        // Si hace clic fuera del botón estando expandido, encogerlo
        document.addEventListener('click', function(e) {
            if (window.innerWidth <= 768 && button.classList.contains('is-expanded')) {
                if (!button.contains(e.target)) {
                    button.classList.remove('is-expanded');
                    if (expandTimeout) clearTimeout(expandTimeout);
                }
            }
        });
    }

    /**
     * Inicialización cuando el DOM está listo
     */
    function init() {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => {
                startAnimations();
                setupModalListeners();
                setupExpandableInteraction();
            });
        } else {
            startAnimations();
            setupModalListeners();
            setupExpandableInteraction();
        }
    }

    // Exportar funciones para acceso externo
    window.btnFlotanteAnimator = {
        start: startAnimations,
        stop: stopAnimations,
        heartbeat: applyHeartbeat,
        vibrate: applyVibrate,
        config: CONFIG
    };

    // Iniciar
    init();

    console.log('✅ [Animator] Módulo de animación de botón flotante cargado');

})();
