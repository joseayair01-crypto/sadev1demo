/**
 * ADMIN RULETAZO - LÓGICA PRINCIPAL
 * Sistema de máquina de ruleta para sorteos administrativos
 */

class RuletazoMachine {
    constructor() {
        this.currentRifa = null;
        this.drawnNumbers = [];
        this.isSpinning = false;
        this.digitCount = 0;
        this.apiBase = (window.rifaplusConfig?.backend?.apiBase)
            || window.rifaplusConfig?.obtenerApiBase?.()
            || window.location.origin;
        this.authToken = localStorage.getItem('adminToken');
        this.participantsMode = 'sold'; // 'all' o 'sold'
    }

    /**
     * Formatea número con ceros iniciales según config.js
     */
    formatNumber(num, forcedDigitCount = null) {
        const numeroLimpio = parseInt(String(num).replace(/[^0-9]/g, ''), 10);

        if (!Number.isFinite(numeroLimpio) || numeroLimpio < 0) {
            const fallbackDigits = Number.isInteger(forcedDigitCount) && forcedDigitCount > 0
                ? forcedDigitCount
                : Math.max(1, this.digitCount || 1);
            return '?'.repeat(fallbackDigits);
        }

        const currentTotal = Number(this.currentRifa?.totalNumbers);
        const digitsFromCurrentRifa = Number.isFinite(currentTotal) && currentTotal > 0
            ? String(Math.max(currentTotal - 1, 0)).length
            : 0;

        const digits = Number.isInteger(forcedDigitCount) && forcedDigitCount > 0
            ? forcedDigitCount
            : Math.max(1, digitsFromCurrentRifa || this.digitCount || 1);

        return String(numeroLimpio).padStart(digits, '0');
    }

    /**
     * Obtiene métricas visuales de una columna del slot
     */
    getColumnMetrics(column, digitNumbers) {
        const firstItem = digitNumbers?.querySelector('.digit-item');
        const itemHeight = firstItem ? firstItem.offsetHeight : 56;
        const columnHeight = column?.offsetHeight || 140;
        const centerOffset = Math.max(0, (columnHeight - itemHeight) / 2);

        return { itemHeight, columnHeight, centerOffset };
    }

    /**
     * Calcula la traslación exacta para centrar un dígito en la ventana
     */
    getCenteredTranslateY(column, digitNumbers, digitIndex) {
        const { itemHeight, centerOffset } = this.getColumnMetrics(column, digitNumbers);
        return -((digitIndex * itemHeight) - centerOffset);
    }

    /**
     * Aplica transform 3D para mantener el giro más fluido
     */
    applyColumnTransform(digitNumbers, translateY) {
        if (!digitNumbers) return;
        digitNumbers.style.transform = `translate3d(0, ${translateY}px, 0)`;
    }

    /**
     * Obtiene lista de rifas activas del backend
     */
    async loadActiveRifas() {
        try {
            // Cargar boletos disponibles para ver qué rifas están activas
            const response = await fetch(`${this.apiBase}/api/public/boletos`);

            if (response.ok) {
                const data = await response.json();
                // Agrupar por rifa
                const rifas = {};
                if (data.data && Array.isArray(data.data)) {
                    data.data.forEach(boleto => {
                        if (!rifas[boleto.rifaId]) {
                            rifas[boleto.rifaId] = {
                                id: boleto.rifaId,
                                name: boleto.rifaNombre || `Rifa ${boleto.rifaId}`
                            };
                        }
                    });
                }
                return Object.values(rifas) || [];
            }
        } catch (error) {
            // Backend no disponible
        }

        // Datos de demostración si el backend falla
        return [
            { id: '1', name: 'iPhone 15 Pro Max 256GB' },
            { id: '2', name: 'Samsung Galaxy S24' },
            { id: '3', name: 'MacBook Pro 14"' }
        ];
    }

    /**
     * Carga datos de una rifa específica
     * ⚠️ CRÍTICO: Envía header X-Rifa-Id para aislamiento multirifa
     */
    async loadRifa(rifaId) {
        try {
            // ⚠️ CRÍTICO: Enviar TANTO query param como header para máximo aislamiento multirifa
            const response = await fetch(`${this.apiBase}/api/public/boletos?rifa_id=${rifaId}`, {
                headers: {
                    'X-Rifa-Id': String(rifaId)
                }
            });

            if (response.ok) {
                const data = await response.json();
                // El endpoint devuelve { sold: [...], reserved: [...] }
                const boletosData = data.data || {};
                const soldNumbers = Array.isArray(boletosData.sold) ? boletosData.sold : [];
                const reservedNumbers = Array.isArray(boletosData.reserved) ? boletosData.reserved : [];

                if (data.success && (Array.isArray(boletosData.sold) || Array.isArray(boletosData.reserved))) {
                    const totalBoletos = obtenerTotalBoletosRuletazo();
                    this.currentRifa = {
                        id: rifaId,
                        name: window.rifaplusConfig?.rifa?.nombreSorteo || this.getSelectedRifaName(rifaId),
                        totalNumbers: totalBoletos, // Dinámico desde config
                        soldNumbers: filtrarNumerosValidosRuletazo(soldNumbers, totalBoletos),
                        reservedNumbers: filtrarNumerosValidosRuletazo(reservedNumbers, totalBoletos)
                    };
                    await this.loadDrawnNumbers(rifaId);
                    console.log(`🎡 Ruletazo.loadRifa: Cargada Rifa ID=${rifaId}, totalBoletos=${totalBoletos}, ${soldNumbers.length} vendidos`);
                    return this.currentRifa;
                }
            }
        } catch (error) {
            console.warn('⚠️ Ruletazo.loadRifa: Backend no disponible:', error.message);
        }

        // Datos de demostración
        const totalBoletos = obtenerTotalBoletosRuletazo();
        this.currentRifa = {
            id: rifaId,
            name: window.rifaplusConfig?.rifa?.nombreSorteo || this.getSelectedRifaName(rifaId),
            totalNumbers: totalBoletos,
            soldNumbers: filtrarNumerosValidosRuletazo(this.generateSoldNumbers(50, totalBoletos), totalBoletos)
        };

        this.drawnNumbers = [];
        return this.currentRifa;
    }

    /**
     * Obtiene el nombre de la rifa seleccionada
     */
    getSelectedRifaName(rifaId) {
        const names = {
            '1': 'iPhone 15 Pro Max 256GB',
            '2': 'Samsung Galaxy S24',
            '3': 'MacBook Pro 14"'
        };
        return names[rifaId] || 'Rifa Demo';
    }

    /**
     * Genera números vendidos de demostración
     * ⚠️ GARANTIZA: num siempre estará entre 1 y max (totalBoletos)
     */
    generateSoldNumbers(count, max) {
        const sold = [];
        while (sold.length < count && sold.length < max) {
            const num = Math.floor(Math.random() * max);
            if (!sold.includes(num)) {
                sold.push(num);
            }
        }
        return sold.sort((a, b) => a - b);
    }

    /**
     * Carga números ya sorteados
     * ⚠️ CRÍTICO: El historial debe persistir entre sesiones y cambios de rifa
     */
    async loadDrawnNumbers(rifaId) {
        try {
            // ⚠️ CRÍTICO: Intentar cargar del localStorage primero
            const stored = localStorage.getItem(`draws_${rifaId}`);
            if (stored) {
                try {
                    const parsed = JSON.parse(stored);
                    const filtered = filtrarNumerosValidosRuletazo(
                        Array.isArray(parsed)
                            ? parsed.map(item => (typeof item === 'object' && item !== null ? Number(item.number) : Number(item))).filter(n => !Number.isNaN(n))
                            : [], 
                        this.currentRifa?.totalNumbers || obtenerTotalBoletosRuletazo()
                    );
                    this.drawnNumbers = filtered;
                    console.log(`🎡 [loadDrawnNumbers] ✅ Cargados ${filtered.length} números sorteados para rifa_id=${rifaId}`);
                    return;
                } catch (parseError) {
                    console.warn(`⚠️ [loadDrawnNumbers] Error parseando historial:`, parseError);
                }
            } else {
                console.log(`ℹ️ [loadDrawnNumbers] No hay historial guardado para rifa_id=${rifaId}`);
            }
        } catch (error) {
            console.warn('⚠️ [loadDrawnNumbers] Error leyendo sorteos locales:', error);
        }

        // Inicializar vacío si no hay datos locales
        this.drawnNumbers = [];
    }

    /**
     * Realiza un sorteo real
     */
    async performRealDraw() {
        try {
            // VALIDACIONES
            if (!this.currentRifa) {
                this.showNotification('Selecciona una rifa primero', 'warning');
                return null;
            }

            const availableNumbers = this.getAvailableNumbers();
            
            if (availableNumbers.length === 0) {
                this.showNotification('No hay números disponibles para sortear', 'error');
                return null;
            }

            // Seleccionar número aleatorio
            const selectedNumber = availableNumbers[
                Math.floor(Math.random() * availableNumbers.length)
            ];

            this.drawnNumbers.push(selectedNumber);
            
            // Animar máquina
            await this.animateDraw(selectedNumber);

            // Guardar historial local
            await this.saveDraw(selectedNumber);

            this.showNotification(`¡Número ganador: ${this.formatNumber(selectedNumber)}!`, 'success');

            return selectedNumber;
        } catch (error) {
            this.showNotification('Error realizando sorteo', 'error');
            return null;
        }
    }

    /**
     * Obtiene números disponibles para sortear según el modo de participantes
     * 
     * GARANTÍAS DE VALIDACIÓN:
     * - Modo 'all': Genera rango 1 a totalNumbers (desde config)
     * - Modo 'sold': Solo devuelve boletos que estén en soldNumbers (vendidos)
     * - Nunca incluye números ya sorteados (drawnNumbers)
     * - Todos los números son <= totalBoletos
     */
    getAvailableNumbers() {
        if (!this.currentRifa) {
            return [];
        }

        // Modo 'todos': todos los números del rango (1 a totalNumbers)
        if (this.participantsMode === 'all') {
            const allNumbers = [];
            for (let i = 0; i < this.currentRifa.totalNumbers; i++) {
                if (!this.drawnNumbers.includes(i)) {
                    allNumbers.push(i);
                }
            }
            return allNumbers;
        }
        
        // Modo 'sold': solo números vendidos (no sorteados)
        if (this.participantsMode === 'sold') {
            return (this.currentRifa.soldNumbers || []).filter(
                num => !this.drawnNumbers.includes(num)
            );
        }
        
        return [];
    }

    /**
     * Obtiene el total de números en el rango actual
     */
    getTotalParticipants() {
        if (!this.currentRifa) return 0;
        
        if (this.participantsMode === 'all') {
            return this.currentRifa.totalNumbers;
        } else if (this.participantsMode === 'sold') {
            return this.currentRifa.soldNumbers?.length || 0;
        }
        return 0;
    }

    /**
     * Anima la máquina para mostrar número
     */
    async animateDraw(targetNumber) {
        return new Promise((resolve) => {
            const machineDiv = document.getElementById('digitMachine');
            if (!machineDiv) {
                resolve();
                return;
            }

            const digitColumns = machineDiv.querySelectorAll('.digit-column');
            const formattedNumber = this.formatNumber(targetNumber, this.digitCount);
            const animationStart = performance.now();
            const totalDuration = 3200;
            const columnConfigs = [];

            this.isSpinning = true;
            this.updateStatus('spinning');

            digitColumns.forEach((column, index) => {
                const targetDigit = parseInt(formattedNumber[index]);
                const digitNumbers = column.querySelector('.digit-numbers');

                if (!digitNumbers) {
                    return;
                }

                digitNumbers.classList.add('spinning');
                digitNumbers.style.willChange = 'transform';
                digitNumbers.style.transition = 'none';

                const startIndex = 2 + (index * 3);
                const extraLoops = 26 + (index * 2);
                const targetIndex = (extraLoops * 10) + targetDigit;
                const startTranslate = this.getCenteredTranslateY(column, digitNumbers, startIndex);
                const endTranslate = this.getCenteredTranslateY(column, digitNumbers, targetIndex);
                const duration = totalDuration - ((digitColumns.length - index - 1) * 140);
                const delay = index * 85;

                this.applyColumnTransform(digitNumbers, startTranslate);
                digitNumbers.dataset.currentTranslate = String(startTranslate);

                columnConfigs.push({
                    digitNumbers,
                    startTranslate,
                    endTranslate,
                    delay,
                    duration,
                    completed: false
                });
            });

            if (!columnConfigs.length) {
                this.isSpinning = false;
                this.updateStatus('ready');
                this.displayWinner(targetNumber);
                resolve();
                return;
            }

            const easeOutExpo = (value) => {
                if (value === 1) return 1;
                return 1 - Math.pow(2, -10 * value);
            };

            const step = (now) => {
                let completedColumns = 0;

                columnConfigs.forEach((config) => {
                    const { digitNumbers, delay, duration, startTranslate, endTranslate } = config;
                    const elapsed = now - animationStart - delay;

                    if (elapsed <= 0) {
                        this.applyColumnTransform(digitNumbers, startTranslate);
                        return;
                    }

                    const progress = Math.min(elapsed / duration, 1);
                    const eased = easeOutExpo(progress);
                    const currentTranslate = startTranslate + ((endTranslate - startTranslate) * eased);

                    this.applyColumnTransform(digitNumbers, currentTranslate);
                    digitNumbers.dataset.currentTranslate = String(currentTranslate);

                    if (progress >= 1) {
                        if (!config.completed) {
                            config.completed = true;
                            digitNumbers.classList.remove('spinning');
                            digitNumbers.style.willChange = 'auto';
                            this.applyColumnTransform(digitNumbers, endTranslate);
                            digitNumbers.dataset.currentTranslate = String(endTranslate);
                        }
                        completedColumns++;
                    }
                });

                if (completedColumns === columnConfigs.length) {
                    this.isSpinning = false;
                    this.updateStatus('ready');
                    this.displayWinner(targetNumber);
                    resolve();
                    return;
                }

                requestAnimationFrame(step);
            };

            requestAnimationFrame(step);
        });
    }

    /**
     * Muestra número ganador
     */
    displayWinner(number) {
        const display = document.getElementById('winningDisplay');
        const numberEl = document.getElementById('winningNumber');
        
        if (!display || !numberEl) return;

        numberEl.textContent = this.formatNumber(number, this.digitCount);
        display.style.display = 'block';

        // Animar entrada
        display.style.animation = 'none';
        setTimeout(() => {
            display.style.animation = 'slideIn 0.5s ease-out';
        }, 10);
    }

    /**
     * Guarda sorteo en localStorage
     * ⚠️ CRÍTICO: El historial debe persistir incluso si hay errores
     */
    async saveDraw(number) {
        try {
            if (!this.currentRifa) {
                console.warn('⚠️ [saveDraw] No hay rifa seleccionada, no se puede guardar');
                return false;
            }

            // ⚠️ CRÍTICO: Guardar TODOS los números sorteados, no solo el último
            const rifaId = this.currentRifa.id;
            const storageKey = `draws_${rifaId}`;
            
            try {
                localStorage.setItem(storageKey, JSON.stringify(this.drawnNumbers));
                console.log(`✅ [saveDraw] Historial guardado: ${this.drawnNumbers.length} números para rifa_id=${rifaId}`);
                return true;
            } catch (e) {
                console.error(`❌ [saveDraw] Error guardando en localStorage:`, e);
                return false;
            }
        } catch (error) {
            console.error('❌ [saveDraw] Error al guardar sorteo:', error);
            return false;
        }
    }

    /**
     * Actualiza estado visual
     */
    updateStatus(status) {
        const statusBadge = document.querySelector('.status-badge');
        const statusTexts = {
            'ready': '✓ Listo',
            'spinning': '🎰 Girando...',
            'error': '⚠ Error'
        };

        if (statusBadge) {
            statusBadge.textContent = statusTexts[status] || status;
            statusBadge.classList.remove('spinning');
            if (status === 'spinning') {
                statusBadge.classList.add('spinning');
            }
        }
    }

    /**
     * Muestra notificación
     */
    showNotification(message, type = 'info') {
        const container = document.getElementById('notificationContainer');
        if (!container) return;

        const icons = {
            'success': 'fas fa-check-circle',
            'error': 'fas fa-exclamation-circle',
            'warning': 'fas fa-exclamation-triangle',
            'info': 'fas fa-info-circle'
        };

        const notification = document.createElement('div');
        notification.className = `notification ${type}`;
        notification.innerHTML = `
            <i class="notification-icon ${icons[type]}"></i>
            <span class="notification-message">${message}</span>
            <button class="notification-close">×</button>
        `;

        container.appendChild(notification);

        notification.querySelector('.notification-close').addEventListener('click', () => {
            notification.remove();
        });

        setTimeout(() => {
            if (notification.parentNode) {
                notification.remove();
            }
        }, 4000);
    }
}

// ============================================
// INICIALIZACIÓN Y EVENT LISTENERS
// ============================================

let machine = null;

function obtenerTotalBoletosRuletazo() {
    // ✅ CRÍTICO: SIEMPRE usar totalBoletos de machine.currentRifa si existe
    // Esta es la FUENTE DE VERDAD una vez que se carga una rifa
    
    if (machine && machine.currentRifa && Number.isFinite(machine.currentRifa.totalNumbers) && machine.currentRifa.totalNumbers > 0) {
        console.log(`📊 obtenerTotalBoletosRuletazo: Retornando desde machine.currentRifa: ${machine.currentRifa.totalNumbers}`);
        return machine.currentRifa.totalNumbers;
    }
    
    // ❌ Si no existe machine.currentRifa, algo salió mal
    console.error(`❌ obtenerTotalBoletosRuletazo: machine.currentRifa NO EXISTE O NO TIENE totalNumbers`);
    console.log(`   machine:`, machine);
    console.log(`   machine.currentRifa:`, machine?.currentRifa);
    
    // Intentar fallback desde localStorage de la rifa activa
    const rifaIdActiva = localStorage.getItem('rifaplus_rifa_activa');
    if (rifaIdActiva) {
        try {
            const cacheKey = `rifaplus:rifa:${rifaIdActiva}:totalBoletos`;
            const cached = localStorage.getItem(cacheKey);
            if (cached) {
                const parsed = JSON.parse(cached);
                const cacheAge = Date.now() - (parsed.timestamp || 0);
                if (cacheAge < 3600000 && Number.isFinite(parsed.totalBoletos) && parsed.totalBoletos > 0) {
                    console.log(`📊 obtenerTotalBoletosRuletazo: Retornando desde localStorage (fallback): ${parsed.totalBoletos}`);
                    return parsed.totalBoletos;
                }
            }
        } catch (e) {
            console.warn(`⚠️ obtenerTotalBoletosRuletazo: Error leyendo localStorage:`, e.message);
        }
    }
    
    // Fallback final
    console.warn(`⚠️ obtenerTotalBoletosRuletazo: Usando fallback final (25000)`);
    return 25000;
}

function obtenerDigitosRuletazo(totalBoletos) {
    const totalNormalizado = Number(totalBoletos);
    if (!Number.isFinite(totalNormalizado) || totalNormalizado <= 0) {
        return 1;
    }
    return Math.max(1, String(Math.max(totalNormalizado - 1, 0)).length);
}

function filtrarNumerosValidosRuletazo(numeros, totalBoletos) {
    const maxNumero = Number(totalBoletos) - 1;
    if (!Array.isArray(numeros) || !Number.isFinite(maxNumero) || maxNumero < 0) {
        return [];
    }

    return Array.from(new Set(
        numeros
            .map((numero) => parseInt(String(numero).replace(/[^0-9]/g, ''), 10))
            .filter((numero) => Number.isFinite(numero) && numero >= 0 && numero <= maxNumero)
    )).sort((a, b) => a - b);
}

const RULETAZO_TICKET_THEME_STORAGE_KEY = 'rifaplus_admin_ruletazo_ticket_card_theme_v1';
const RULETAZO_TICKET_THEME_DEFAULT = Object.freeze({
    primary: '#0b2238',
    primaryDark: '#153e5c',
    tint: 'rgba(11, 34, 56, 0.08)',
    border: 'rgba(11, 34, 56, 0.18)'
});

function normalizarColorHexRuletazo(valor, fallback = '') {
    const normalizador = typeof window.normalizarHexColorSeguro === 'function'
        ? window.normalizarHexColorSeguro
        : (input, localFallback = '') => {
            const limpio = String(input || '').trim();
            const match = limpio.match(/^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/);
            if (!match) return localFallback;
            const hex = match[1];
            if (hex.length === 3) {
                return `#${hex.split('').map((char) => char + char).join('').toLowerCase()}`;
            }
            return `#${hex.toLowerCase()}`;
        };

    return normalizador(valor, fallback);
}

function enriquecerTemaRuletazoTicketCard(primary, primaryDark) {
    const rgb = typeof window.hexToRgbSeguro === 'function'
        ? window.hexToRgbSeguro(primary)
        : null;

    if (!rgb || !Number.isFinite(rgb.r) || !Number.isFinite(rgb.g) || !Number.isFinite(rgb.b)) {
        return {
            primary,
            primaryDark,
            tint: RULETAZO_TICKET_THEME_DEFAULT.tint,
            border: RULETAZO_TICKET_THEME_DEFAULT.border
        };
    }

    return {
        primary,
        primaryDark,
        tint: `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.08)`,
        border: `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.18)`
    };
}

function leerTemaPublicoCacheadoRuletazoTicketCard() {
    try {
        const bruto = localStorage.getItem(RULETAZO_TICKET_THEME_STORAGE_KEY);
        if (!bruto) return null;
        const tema = JSON.parse(bruto);
        const primary = normalizarColorHexRuletazo(tema?.primary, '');
        if (!primary) return null;
        const primaryDark = normalizarColorHexRuletazo(
            tema?.primaryDark,
            typeof window.ajustarLuminosidadHex === 'function'
                ? window.ajustarLuminosidadHex(primary, -0.22)
                : primary
        );
        return enriquecerTemaRuletazoTicketCard(primary, primaryDark);
    } catch (error) {
        return null;
    }
}

function resolverTemaPublicoRuletazoTicketCard(config = window.rifaplusConfig || {}) {
    const temaConfig = config?.tema || {};
    const coloresTema = temaConfig?.colores || {};
    const clienteConfig = config?.cliente || {};
    const clienteColores = clienteConfig?.colores || {};
    const temaPersonalizadoActivo = temaConfig?.personalizado === true;

    const candidatosPrimary = temaPersonalizadoActivo
        ? [
            temaConfig?.colorPrimario,
            coloresTema?.colorPrimario,
            coloresTema?.primary,
            clienteConfig?.colorPrimario,
            clienteColores?.colorPrimario,
            clienteColores?.primary,
            RULETAZO_TICKET_THEME_DEFAULT.primary
        ]
        : [
            clienteConfig?.colorPrimario,
            clienteColores?.colorPrimario,
            clienteColores?.primary,
            RULETAZO_TICKET_THEME_DEFAULT.primary
        ];

    const primary = candidatosPrimary
        .map((valor) => normalizarColorHexRuletazo(valor, ''))
        .find(Boolean) || RULETAZO_TICKET_THEME_DEFAULT.primary;

    const primaryDarkFallback = typeof window.ajustarLuminosidadHex === 'function'
        ? window.ajustarLuminosidadHex(primary, -0.22)
        : primary;

    const candidatosPrimaryDark = temaPersonalizadoActivo
        ? [
            temaConfig?.colorPrimarioOscuro,
            coloresTema?.colorPrimarioOscuro,
            coloresTema?.primaryDark,
            clienteConfig?.colorPrimarioDark,
            clienteColores?.colorPrimarioDark,
            clienteColores?.primaryDark,
            primaryDarkFallback
        ]
        : [
            clienteConfig?.colorPrimarioDark,
            clienteColores?.colorPrimarioDark,
            clienteColores?.primaryDark,
            primaryDarkFallback
        ];

    const primaryDark = candidatosPrimaryDark
        .map((valor) => normalizarColorHexRuletazo(valor, ''))
        .find(Boolean) || primaryDarkFallback;

    return enriquecerTemaRuletazoTicketCard(primary, primaryDark);
}

function aplicarTemaResueltoRuletazoTicketCard(tema) {
    const root = document.documentElement;
    root.style.setProperty('--ticket-card-public-primary', tema.primary);
    root.style.setProperty('--ticket-card-public-primary-dark', tema.primaryDark);
    root.style.setProperty('--ticket-card-public-primary-tint', tema.tint || RULETAZO_TICKET_THEME_DEFAULT.tint);
    root.style.setProperty('--ticket-card-public-primary-border', tema.border || RULETAZO_TICKET_THEME_DEFAULT.border);
    root.dataset.ticketCardPublicPrimary = tema.primary;
    window.__rifaplusRuletazoTicketCardPublicTheme = tema;

    try {
        localStorage.setItem(RULETAZO_TICKET_THEME_STORAGE_KEY, JSON.stringify({
            primary: tema.primary,
            primaryDark: tema.primaryDark
        }));
    } catch (error) {
        // ignore
    }
}

function aplicarColorPublicoTicketCardRuletazo(config = window.rifaplusConfig || {}) {
    try {
        const temaResuelto = resolverTemaPublicoRuletazoTicketCard(config)
            || window.__rifaplusRuletazoTicketCardPublicTheme
            || leerTemaPublicoCacheadoRuletazoTicketCard()
            || RULETAZO_TICKET_THEME_DEFAULT;
        aplicarTemaResueltoRuletazoTicketCard(temaResuelto);
    } catch (error) {
        aplicarTemaResueltoRuletazoTicketCard(
            window.__rifaplusRuletazoTicketCardPublicTheme
            || leerTemaPublicoCacheadoRuletazoTicketCard()
            || RULETAZO_TICKET_THEME_DEFAULT
        );
    }
}

function enmascararTelefonoRuletazo(numero = '') {
    const digits = String(numero || '').replace(/[^0-9]/g, '');
    if (!digits) return 'No disponible';
    return `••••••••${digits.slice(-2)}`;
}

function abrirWhatsappRuletazo(numeroWhatsapp, estado) {
    let numero = String(numeroWhatsapp || '').trim().replace(/[^0-9]/g, '');
    if (numero.length < 10) return;
    numero = numero.slice(-10);

    const estadoLower = String(estado || '').trim().toLowerCase();
    const prefijo = estadoLower === 'estados unidos' ? '+1' : '+52';
    const url = `https://wa.me/${prefijo}${numero}`;
    window.open(url, '_blank', 'noopener,noreferrer');
}

function toggleWhatsappRuletazo(elementId, numeroWhatsapp) {
    const el = document.getElementById(elementId);
    if (!el) return;
    const digits = String(numeroWhatsapp || '').replace(/[^0-9]/g, '');
    if (!digits) return;

    const isVisible = el.dataset.visible === 'true';
    el.textContent = isVisible ? enmascararTelefonoRuletazo(digits) : digits;
    el.dataset.visible = isVisible ? 'false' : 'true';

    const btn = document.querySelector(`button[data-whatsapp-toggle-id="${elementId}"]`);
    const icon = btn?.querySelector('i');
    if (icon) {
        icon.classList.toggle('fa-eye', isVisible);
        icon.classList.toggle('fa-eye-slash', !isVisible);
    }

    if (!isVisible) {
        el.style.cursor = 'pointer';
        el.style.color = '#0084ff';
        el.style.textDecoration = 'underline';
    } else {
        el.style.removeProperty('cursor');
        el.style.removeProperty('color');
        el.style.removeProperty('text-decoration');
    }
}

/**
 * 🔒 Obtiene y valida el ID de la rifa seleccionada con máxima robustez
 * Prioridad: Selector DOM > adminLayout > localStorage > fallback
 */
function obtenerRifaIdSeleccionada() {
    let rifaId = null;
    const selectElement = document.getElementById('adminRifaSelect');
    
    // 1️⃣ Fuente más confiable: el selector DOM (lo que el usuario seleccionó)
    if (selectElement?.value) {
        rifaId = String(selectElement.value).trim();
        if (rifaId && /^\d+$/.test(rifaId)) {
            console.log(`📋 Ruletazo: ✅ RifaId desde SELECTOR DOM: ${rifaId}`);
            return Number.parseInt(rifaId, 10);
        }
    }
    
    // 2️⃣ Fuente secundaria: adminLayout API
    if (window.adminLayout?.getActiveRifaId) {
        try {
            rifaId = window.adminLayout.getActiveRifaId();
            if (rifaId && /^\d+$/.test(String(rifaId))) {
                console.log(`📋 Ruletazo: ✅ RifaId desde adminLayout: ${rifaId}`);
                return Number.parseInt(String(rifaId), 10);
            }
        } catch (e) {
            console.warn(`⚠️ Ruletazo: Error en adminLayout.getActiveRifaId():`, e.message);
        }
    }
    
    // 3️⃣ Fuente de último recurso: localStorage
    if (!rifaId) {
        rifaId = localStorage.getItem('rifaplus_rifa_activa');
        if (rifaId && /^\d+$/.test(String(rifaId))) {
            console.log(`📋 Ruletazo: ✅ RifaId desde localStorage: ${rifaId}`);
            return Number.parseInt(String(rifaId), 10);
        }
    }
    
    // 4️⃣ Fallback final
    console.warn(`⚠️ Ruletazo: No se pudo determinar RifaId, usando fallback: 1`);
    return 1;
}

document.addEventListener('DOMContentLoaded', async () => {
    machine = new RuletazoMachine();
    aplicarColorPublicoTicketCardRuletazo();

    if (window.GanadoresManager?.refrescarDesdeServidor) {
        try {
            await window.GanadoresManager.refrescarDesdeServidor();
        } catch (error) {
            console.warn('[admin-ruletazo] No se pudieron refrescar ganadores desde servidor:', error);
        }
    }

    // Esperar a que config-sync termine si aún no ha poblado totalBoletos real
    const totalInicial = Number(window.rifaplusConfig?.rifa?.totalBoletos);
    if (Number.isFinite(totalInicial) && totalInicial > 0 && totalInicial !== 100000 && totalInicial !== 250000) {
        await loadCurrentRifa();
    } else {
        window.addEventListener('configSyncCompleto', async () => {
            await loadCurrentRifa();
        }, { once: true });
    }

    // Event Listeners
    document.getElementById('testSpinBtn').addEventListener('click', testSpin);
    document.getElementById('performDrawBtn').addEventListener('click', performDraw);
    document.getElementById('resetMachineBtn').addEventListener('click', resetMachine);
    document.getElementById('exportHistoryBtn').addEventListener('click', exportHistory);
    document.getElementById('clearHistoryBtn').addEventListener('click', clearHistory);

    // Accordion Event Listeners
    const accordionBtn = document.getElementById('accordionBtn');
    const accordionContent = document.getElementById('accordionContent');
    const participantRadios = document.querySelectorAll('.participant-radio');

    if (accordionBtn) {
        accordionBtn.addEventListener('click', () => {
            accordionBtn.classList.toggle('active');
            accordionContent.classList.toggle('open');
        });
    }

    // Participant selection
    participantRadios.forEach(radio => {
        radio.addEventListener('change', (e) => {
            machine.participantsMode = e.target.value;
            updateParticipantsCounts();
            updateMachineAvailability();
        });
    });
    
    // ===================================
    // 🔥 SISTEMA REACTIVO: Escuchar cambios en el selector de rifas
    // ===================================
    const selectorPromise = (typeof window.ADMIN_LAYOUT?.cargarSelectorRifas === 'function') 
        ? window.ADMIN_LAYOUT.cargarSelectorRifas().catch(e => {
            console.warn('Error selector:', e);
            return null;
        })
        : (typeof window.adminLayout?.cargarSelectorRifas === 'function')
            ? window.adminLayout.cargarSelectorRifas().catch(e => {
                console.warn('Error selector:', e);
                return null;
            })
            : Promise.resolve();

    // Esperar a que el selector esté listo en el DOM para evitar la condición de carrera
    await selectorPromise;

    const adminRifaSelect = document.getElementById('adminRifaSelect');
    if (adminRifaSelect) {
        console.log(`✅ Ruletazo: Event listener agregado a adminRifaSelect`);
        
        adminRifaSelect.addEventListener('change', async (e) => {
            const nuevaRifaId = e.target.value;
            console.log(`🔄 Ruletazo: CAMBIO DE RIFA DETECTADO - Nueva ID: ${nuevaRifaId}`);
            
            // Validar que la nueva rifa ID sea válida
            if (nuevaRifaId && /^\d+$/.test(String(nuevaRifaId))) {
                // Guardar en localStorage como referencia
                localStorage.setItem('rifaplus_rifa_activa', String(nuevaRifaId));
                console.log(`✅ Ruletazo: localStorage actualizado con rifaId: ${nuevaRifaId}`);
                
                // Recargar datos de la rifa seleccionada
                console.log(`⏳ Ruletazo: Recargando datos de rifa ${nuevaRifaId}...`);
                await loadCurrentRifa();
                console.log(`✅ Ruletazo: Rifa ${nuevaRifaId} cargada correctamente`);
            } else {
                console.warn(`⚠️ Ruletazo: RifaId inválida en onChange: ${nuevaRifaId}`);
            }
        });
    } else {
        console.warn(`⚠️ Ruletazo: No se encontró elemento adminRifaSelect incluso tras esperar a su carga asíncrona`);
    }
    
    // Cargar rifa inicial de forma garantizada y asíncrona
    console.log(`⏳ Ruletazo: Cargando rifa inicial...`);
    await loadCurrentRifa();
    
    // Reactividad global: reaccionar a cambios de rifa activa desde admin-layout
    window.addEventListener('rifaplus:admin-rifa-activa-cambiada', async (event) => {
        try {
            const nuevaRifa = event?.detail?.rifaId || localStorage.getItem('rifaplus_rifa_activa');
            console.log(`🔔 Ruletazo: rifaplus:admin-rifa-activa-cambiada detectado -> ${nuevaRifa}`);

            const statsEl = document.getElementById('statsSection');
            const machineEl = document.getElementById('machineSection');

            if (statsEl) {
                statsEl.style.transition = 'opacity 220ms ease';
                statsEl.style.opacity = '0.45';
                statsEl.style.pointerEvents = 'none';
            }

            if (machineEl) {
                machineEl.style.transition = 'opacity 220ms ease';
                machineEl.style.opacity = '0.45';
                machineEl.style.pointerEvents = 'none';
            }

            // Si no hay id (limpiado), limpiar UI
            if (!nuevaRifa) {
                console.log('🔔 Ruletazo: rifa activa limpiada — ocultando stats');
                if (statsEl) statsEl.style.display = 'none';
                if (machineEl) machineEl.style.display = 'none';
                return;
            }

            // Asegurarse que el select refleje el valor
            const select = document.getElementById('adminRifaSelect');
            if (select && String(select.value) !== String(nuevaRifa)) {
                try { select.value = String(nuevaRifa); } catch (e) {}
            }

            // Recargar datos de la rifa seleccionada sin forzar reload de página
            await loadCurrentRifa();

            // Restaurar apariencia
            if (statsEl) {
                statsEl.style.opacity = '1';
                statsEl.style.pointerEvents = '';
            }
            if (machineEl) {
                machineEl.style.opacity = '1';
                machineEl.style.pointerEvents = '';
            }

            console.log('🔔 Ruletazo: UI actualizada tras cambio de rifa activa');
        } catch (e) {
            console.warn('⚠️ Ruletazo: Error manejando cambio de rifa activa:', e?.message || e);
        }
    });


    // Cerrar modal al hacer click fuera del contenido
    const ticketModal = document.getElementById('ticketModal');
    if (ticketModal) {
        ticketModal.addEventListener('click', (e) => {
            if (e.target === ticketModal) {
                closeTicketModal();
            }
        });
    }
    
    // ===================================
    // SISTEMA REACTIVO: Escuchar cambios en configuración
    // ===================================
    if (window.rifaplusConfig && typeof window.rifaplusConfig.onChange === 'function') {
        window.rifaplusConfig.onChange(function(cambio) {
            if (cambio.seccion === 'tema' || cambio.seccion === 'cliente') {
                aplicarColorPublicoTicketCardRuletazo();
            }
            // Si cambia el total de boletos, recargar rifa
            if (cambio.seccion === 'rifa' && cambio.campo === 'totalBoletos') {
                if (typeof loadCurrentRifa === 'function') {
                    loadCurrentRifa();
                }
            }
            
            // Si cambia el título, actualizar
            if (cambio.seccion === 'rifa' && cambio.campo === 'titulo') {
                if (typeof selectRifa === 'function') {
                    selectRifa('1');
                }
            }
        });
    }

    window.addEventListener('configSyncCompleto', () => {
        aplicarColorPublicoTicketCardRuletazo();
        if (typeof loadCurrentRifa === 'function') {
            loadCurrentRifa();
        }
    });
});

/**
 * Carga la rifa actual/activa automáticamente desde adminRifaSelect
 * ⚠️ CRÍTICO: Respeta la rifa seleccionada en el selector admin
 */
async function loadCurrentRifa() {
    try {
        // ✅ OBTENER RIFA SELECCIONADA DE FORMA INMEDIATA
        const rifaIdSeleccionada = obtenerRifaIdSeleccionada();
        
        if (!rifaIdSeleccionada || rifaIdSeleccionada <= 0) {
            console.warn(`⚠️ Ruletazo: RifaId inválido: ${rifaIdSeleccionada}, reintentando en breve...`);
            setTimeout(loadCurrentRifa, 500);
            return;
        }

        console.log(`🎡 Ruletazo: Cargando rifa seleccionada ID=${rifaIdSeleccionada} (Relámpago)`);

        const token = localStorage.getItem('rifaplus_admin_token') || localStorage.getItem('admin_token');
        
        // 🚀 LANZAR TODO EN PARALELO
        const [rifasRes, boletosRes] = await Promise.all([
            fetch(`${machine.apiBase}/api/admin/rifas?incluirDepuradas=true`, {
                headers: { 'Authorization': `Bearer ${token}` }
            }).catch(e => ({ ok: false, error: e })),
            
            fetch(`${machine.apiBase}/api/public/boletos?rifa_id=${rifaIdSeleccionada}`, {
                headers: { 'X-Rifa-Id': String(rifaIdSeleccionada) }
            }).catch(e => ({ ok: false, error: e }))
        ]);

        let rifaData = null;
        if (rifasRes.ok) {
            const data = await rifasRes.json();
            const rifas = Array.isArray(data.data) ? data.data : [];
            rifaData = rifas.find(r => String(r.id) === String(rifaIdSeleccionada));
        }

        let soldNumbers = [];
        let reservedNumbers = [];
        let totalNumbers = 0;
        let datosBackendCargados = false;

        if (boletosRes.ok) {
            const boletosData = await boletosRes.json();
            if (boletosData.success && boletosData.data) {
                // El total viene de la config de la rifa o de los boletos
                totalNumbers = Number(rifaData?.configuracion?.rifa?.totalBoletos || rifaData?.totalBoletos || 0);
                
                // Fallback de total si no está en rifaData
                if (!totalNumbers) {
                    const cached = localStorage.getItem(`rifaplus:rifa:${rifaIdSeleccionada}:totalBoletos`);
                    if (cached) {
                        try {
                            totalNumbers = JSON.parse(cached).totalBoletos;
                        } catch(e) {}
                    }
                }

                if (!totalNumbers) totalNumbers = 25000; // Último recurso

                soldNumbers = filtrarNumerosValidosRuletazo(boletosData.data.sold || [], totalNumbers);
                reservedNumbers = filtrarNumerosValidosRuletazo(boletosData.data.reserved || [], totalNumbers);
                datosBackendCargados = true;
            }
        }

        // Buscar totalBoletos en MÚLTIPLES paths posibles del rifaData
        if (rifaData) {
            console.log(`🔍 Ruletazo: Buscando totalBoletos en rifaData...`);
            
            if (rifaData?.configuracion?.rifa?.totalBoletos) {
                totalNumbers = Number(rifaData.configuracion.rifa.totalBoletos);
            } else if (rifaData?.totalBoletos) {
                totalNumbers = Number(rifaData.totalBoletos);
            }

            if (!totalNumbers) {
                for (const key of Object.keys(rifaData)) {
                    if (key.toLowerCase().includes('total') && String(rifaData[key]).match(/^\d+$/)) {
                        totalNumbers = Number(rifaData[key]);
                        console.log(`✅ Ruletazo: totalBoletos en campo ${key}: ${totalNumbers}`);
                        break;
                    }
                }
            }
        }
            
        // ✅ Guardar en localStorage para futuro uso
        if (totalNumbers && totalNumbers > 0) {
            try {
                localStorage.setItem(`rifaplus:rifa:${rifaIdSeleccionada}:totalBoletos`, JSON.stringify({
                    totalBoletos: totalNumbers,
                    timestamp: Date.now()
                }));
            } catch (e) {}
        }

        // Fallback 1: localStorage
        if (!totalNumbers || totalNumbers <= 0) {
            try {
                const cached = localStorage.getItem(`rifaplus:rifa:${rifaIdSeleccionada}:totalBoletos`);
                if (cached) {
                    const parsed = JSON.parse(cached);
                    totalNumbers = parsed.totalBoletos;
                }
            } catch (e) {}
        }
        
        // Fallback 2: Contexto
        if (!totalNumbers || totalNumbers <= 0) {
            const contextTotal = Number(window.rifaplusConfig?._adminRifaContext?.totalBoletos);
            if (contextTotal) totalNumbers = contextTotal;
        }
        
        // Fallback 3: Config global
        if (!totalNumbers || totalNumbers <= 0) {
            const config = window.rifaplusConfig || {};
            const globalTotal = Number(config.rifa?.totalBoletos);
            const globalRifaId = config.rifa?.id || config._activeRifaId;
            if (String(globalRifaId) === String(rifaIdSeleccionada)) {
                totalNumbers = globalTotal;
            }
        }
        
        // Fallback 4: Valor por defecto
        if (!totalNumbers || totalNumbers <= 0) {
            totalNumbers = 25000;
        }
        
        const config = window.rifaplusConfig || {};
        const rifaTitle = rifaData?.nombre || config.rifa?.nombreSorteo || 'Sorteo en Vivo';
        
        console.log(`🎡 Ruletazo: Total boletos para rifa ${rifaIdSeleccionada}: ${totalNumbers}`);

        if (!datosBackendCargados) {
            try {
                const boletosResponse = await fetch(`${machine.apiBase}/api/public/boletos?rifa_id=${rifaIdSeleccionada}`, {
                    headers: { 'X-Rifa-Id': String(rifaIdSeleccionada) }
                });
                
                if (boletosResponse.ok) {
                    const boletosData = await boletosResponse.json();
                    if (boletosData.success && boletosData.data) {
                        soldNumbers = filtrarNumerosValidosRuletazo(boletosData.data.sold || [], totalNumbers);
                        reservedNumbers = filtrarNumerosValidosRuletazo(boletosData.data.reserved || [], totalNumbers);
                        datosBackendCargados = true;
                    }
                }
            } catch (error) {
                console.warn('⚠️ Ruletazo: Error reintentando carga:', error.message);
            }
        }

        if (!datosBackendCargados) {
            soldNumbers = filtrarNumerosValidosRuletazo(
                machine.generateSoldNumbers(Math.floor(totalNumbers * 0.3), totalNumbers),
                totalNumbers
            );
        }

        machine.currentRifa = {
            id: rifaIdSeleccionada,
            name: rifaTitle,
            totalNumbers: totalNumbers,
            soldNumbers: soldNumbers,
            reservedNumbers: reservedNumbers
        };
        
        await selectRifa(rifaIdSeleccionada);
        console.log(`✅ Ruletazo: Rifa cargada ID=${rifaIdSeleccionada}, Total=${totalNumbers}`);
    } catch (error) {
        console.error('❌ Ruletazo: Error cargando rifa:', error);
        await selectRifa(localStorage.getItem('rifaplus_rifa_activa') || '1');
    }
}

/**
 * Selecciona una rifa
 */
async function selectRifa(rifaId) {
    console.log(`🎡 selectRifa INIT: rifaId=${rifaId}, machine.currentRifa.id=${machine.currentRifa?.id}, coinciden=${String(machine.currentRifa?.id) === String(rifaId)}`);
    
    let rifa = null;

    if (machine.currentRifa && String(machine.currentRifa.id) === String(rifaId)) {
        console.log(`🎡 selectRifa: Usando machine.currentRifa directamente (ya está cargada)`);
        rifa = machine.currentRifa;
        await machine.loadDrawnNumbers(rifaId);
    } else {
        console.log(`🎡 selectRifa: machine.currentRifa no coincide, llamando machine.loadRifa(${rifaId})`);
        rifa = await machine.loadRifa(rifaId);
    }
    
    if (!rifa) {
        console.warn(`⚠️ selectRifa: rifa es null!`);
        return;
    }

    // Mostrar información
    // ⚠️ CRÍTICO: totalBoletos DEBE venir de machine.currentRifa que fue configurado en loadCurrentRifa()
    // NUNCA del config global que puede ser de otra rifa
    const totalBoletos = machine.currentRifa?.totalNumbers || obtenerTotalBoletosRuletazo();
    const vendidos = rifa.soldNumbers?.length || 0;
    const disponibles = totalBoletos - vendidos; // Disponibles = total - vendidos
    
    console.log(`🎡 selectRifa DISPLAY: totalBoletos=${totalBoletos}, vendidos=${vendidos}, disponibles=${disponibles}, rifaId=${rifaId}`);
    
    // Actualizar info panel
    // ⚠️ CRÍTICO: Usar SIEMPRE el nombre de machine.currentRifa, NO de config global
    // machine.currentRifa.name tiene el nombre correcto de la rifa que se acaba de cargar
    const rifaNombre = machine.currentRifa?.name || 'Sorteo Actual';
    
    console.log(`🎡 Nombre del sorteo: ${rifaNombre} (de machine.currentRifa)`);
    console.log(`📊 machine.currentRifa:`, machine.currentRifa);
    
    document.getElementById('rifaNombre').textContent = rifaNombre;
    document.getElementById('rifaTotal').textContent = totalBoletos;
    document.getElementById('rifaVendidos').textContent = vendidos;
    document.getElementById('rifaDisponibles').textContent = disponibles;

    // Calcular dígitos basado en totalBoletos
    machine.digitCount = obtenerDigitosRuletazo(totalBoletos);
    document.getElementById('rifaDigitos').textContent = machine.digitCount;

    // Mostrar paneles
    const statsEl = document.getElementById('statsSection');
    try {
        if (statsEl) {
            statsEl.style.display = 'grid';
            // Quitar estado de carga y restaurar opacidad (skeleton -> contenido)
            statsEl.removeAttribute('aria-busy');
            statsEl.style.transition = 'opacity 220ms ease';
            statsEl.style.opacity = '1';
        }
    } catch (e) { console.warn('⚠️ Ruletazo: no se pudo mostrar statsSection:', e); }
    document.getElementById('machineSection').style.display = 'block';
    document.getElementById('historySection').style.display = 'block';

    // Inicializar modo de participantes (por defecto 'sold')
    machine.participantsMode = 'sold';
    document.querySelector('input[name="participants"][value="sold"]').checked = true;
    updateParticipantsCounts();

    // Generar máquina
    generateMachine();

    // Habilitar botón de sorteo si hay números disponibles
    const availableCount = machine.getAvailableNumbers().length;
    document.getElementById('performDrawBtn').disabled = availableCount === 0;

    // Cargar historial
    loadHistory();
}

/**
 * Genera la máquina de ruleta
 */
function generateMachine() {
    const machineDiv = document.getElementById('digitMachine');
    machineDiv.innerHTML = '';
    const repetitions = Math.max(34, 30 + (machine.digitCount * 2));

    for (let i = 0; i < machine.digitCount; i++) {
        const column = document.createElement('div');
        column.className = 'digit-column';

        const numberContainer = document.createElement('div');
        numberContainer.className = 'digit-numbers';

        for (let loop = 0; loop < repetitions; loop++) {
            for (let j = 0; j < 10; j++) {
                const digit = document.createElement('div');
                digit.className = 'digit-item';
                digit.textContent = j;
                numberContainer.appendChild(digit);
            }
        }

        column.appendChild(numberContainer);
        machineDiv.appendChild(column);
    }

    requestAnimationFrame(() => {
        machineDiv.querySelectorAll('.digit-column').forEach((column) => {
            const digits = column.querySelector('.digit-numbers');
            if (!digits) return;

            const startTranslate = machine.getCenteredTranslateY(column, digits, 0);
            machine.applyColumnTransform(digits, startTranslate);
            digits.dataset.currentTranslate = String(startTranslate);
        });
    });

    // Resetear display ganador
    document.getElementById('winningDisplay').style.display = 'none';
    document.getElementById('drawCounter').textContent = `Sorteo #${machine.drawnNumbers.length + 1}`;
}

/**
 * Prueba animación de giro
 * ⚠️ IMPORTANTE: Selecciona un número válido según el modo de participantes
 */
async function testSpin() {
    if (machine.isSpinning) return;

    // Obtener números disponibles según el modo (all o sold)
    const availableNumbers = machine.getAvailableNumbers();
    
    if (availableNumbers.length === 0) {
        machine.showNotification('No hay números disponibles para probar', 'warning');
        return;
    }

    // Seleccionar número aleatorio de los disponibles
    const randomNumber = availableNumbers[
        Math.floor(Math.random() * availableNumbers.length)
    ];
    
    // Test spin
    await machine.animateDraw(randomNumber);
    machine.showNotification('Prueba de giro completada', 'info');
}

/**
 * Actualiza los conteos de participantes en el acordeón
 */
function updateParticipantsCounts() {
    if (!machine.currentRifa) {
        console.warn('⚠️ updateParticipantsCounts: No hay rifa seleccionada');
        return;
    }

    const totalCount = machine.currentRifa.totalNumbers || 0;
    const soldCount = machine.currentRifa.soldNumbers?.length || 0;
    
    console.log(`📊 updateParticipantsCounts: totalCount=${totalCount}, soldCount=${soldCount}, rifaId=${machine.currentRifa.id}`);
    
    // Actualizar "Todos"
    document.getElementById('allCount').textContent = totalCount;

    // Actualizar "Vendidos" - SOLO VENDIDOS
    document.getElementById('soldCount').textContent = soldCount;
}

/**
 * Actualiza disponibilidad de máquina basado en modo de participantes
 */
function updateMachineAvailability() {
    if (!machine.currentRifa) return;

    // ⚠️ IMPORTANTE: totalBoletos SIEMPRE viene de config, NUNCA del backend
    const totalBoletos = obtenerTotalBoletosRuletazo();
    const vendidos = machine.currentRifa.soldNumbers?.length || 0;
    const disponibles = totalBoletos - vendidos; // Los disponibles son total - vendidos
    
    // Actualizar info panel con datos reales
    document.getElementById('rifaDisponibles').textContent = disponibles;
    
    // Habilitar/deshabilitar botón de sorteo basado en números disponibles para sortear
    const availableForDraw = machine.getAvailableNumbers().length;
    document.getElementById('performDrawBtn').disabled = availableForDraw === 0;
    
    // Mostrar mensaje si no hay disponibles
    if (availableForDraw === 0) {
        machine.showNotification('No hay más números disponibles en este modo', 'warning');
    }
}

/**
 * Realiza sorteo real
 */
async function performDraw() {
    if (machine.isSpinning) return;

    document.getElementById('performDrawBtn').disabled = true;
    const number = await machine.performRealDraw();
    
    if (number !== null) {
        // Actualizar información
        document.getElementById('rifaDisponibles').textContent = machine.getAvailableNumbers().length;
        document.getElementById('drawCounter').textContent = `Sorteo #${machine.drawnNumbers.length + 1}`;

        // Cargar historial
        loadHistory();

        // Habilitar/deshabilitar botón según disponibles
        const availableCount = machine.getAvailableNumbers().length;
        document.getElementById('performDrawBtn').disabled = availableCount === 0;
    } else {
        document.getElementById('performDrawBtn').disabled = false;
    }
}

/**
 * Reinicia la máquina
 */
function resetMachine() {
    if (machine.isSpinning) return;

    document.getElementById('winningDisplay').style.display = 'none';
    const columns = document.querySelectorAll('.digit-column');
    
    columns.forEach(column => {
        const numbers = column.querySelector('.digit-numbers');
        numbers.style.transform = 'translateY(0)';
    });

    machine.updateStatus('ready');
    machine.showNotification('Máquina reiniciada', 'info');
}

/**
 * Carga historial de sorteos
 * ⚠️ CRÍTICO: El historial debe mostrarse siempre que haya números guardados
 */
async function loadHistory() {
    if (!machine.currentRifa) {
        console.warn('⚠️ [loadHistory] No hay rifa seleccionada');
        return;
    }

    const historyList = document.getElementById('historyList');
    if (!historyList) {
        console.warn('⚠️ [loadHistory] Elemento historyList no encontrado');
        return;
    }

    console.log(`📋 [loadHistory] Cargando historial: ${machine.drawnNumbers.length} números para rifa_id=${machine.currentRifa.id}`);

    if (machine.drawnNumbers.length === 0) {
        // Verificar si hay datos en localStorage
        const stored = localStorage.getItem(`draws_${machine.currentRifa.id}`);
        if (stored) {
            console.log(`ℹ️ [loadHistory] Hay datos en localStorage pero no en memoria, recargando...`);
            await machine.loadDrawnNumbers(machine.currentRifa.id);
        }
        
        if (machine.drawnNumbers.length === 0) {
            historyList.innerHTML = `
                <div class="history-empty">
                    <i class="fas fa-inbox"></i>
                    <p>No hay sorteos registrados aún</p>
                </div>
            `;
        }
        return;
    }

    historyList.innerHTML = machine.drawnNumbers
        .slice()
        .reverse()
        .map((number, index) => {
            const formatted = machine.formatNumber(number, machine.digitCount);
            const time = new Date().toLocaleTimeString();

            return `
                <div class="history-item">
                    <div class="history-item-number">${formatted}</div>
                    <div class="history-item-info">
                        <span class="history-item-label">Sorteo #${machine.drawnNumbers.length - index}</span>
                        <span class="history-item-time">${time}</span>
                    </div>
                    <button class="btn btn-sm btn-outline" onclick="viewTicketDetails(${number})">Ver boleto</button>
                </div>
            `;
        })
        .join('');
    
    console.log(`✅ [loadHistory] Historial mostrado: ${machine.drawnNumbers.length} números`);
}

/**
 * Exporta historial a CSV
 */
function exportHistory() {
    if (!machine.currentRifa || machine.drawnNumbers.length === 0) {
        machine.showNotification('No hay datos para exportar', 'warning');
        return;
    }

    let csv = 'Rifa,Número,Posición\n';
    
    machine.drawnNumbers.forEach((number, index) => {
        const formatted = machine.formatNumber(number, machine.digitCount);
        csv += `"${machine.currentRifa.name}","${formatted}",${index + 1}\n`;
    });

    const blob = new Blob([csv], { type: 'text/csv' });
    const url = window.URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `historial-sorteos-${new Date().toISOString().split('T')[0]}.csv`;
    link.click();

    machine.showNotification('Historial exportado', 'success');
}

/**
 * Limpia el historial de sorteos
 */
function clearHistory() {
    if (!machine.currentRifa) {
        machine.showNotification('Selecciona una rifa primero', 'warning');
        return;
    }

    if (machine.drawnNumbers.length === 0) {
        machine.showNotification('El historial ya está vacío', 'info');
        return;
    }

    // Confirmar antes de limpiar
    if (!confirm(`¿Estás seguro de que quieres limpiar el historial?\n\nEsto eliminará ${machine.drawnNumbers.length} número(s) sorteado(s) y los devolverá como disponibles.`)) {
        return;
    }

    // Limpiar números sorteados
    machine.drawnNumbers = [];

    // Guardar cambios en localStorage
    try {
        localStorage.setItem(`draws_${machine.currentRifa.id}`, JSON.stringify(machine.drawnNumbers));
    } catch (e) {
        // No se pudo guardar
    }

    // Actualizar interfaz
    updateParticipantsCounts();
    updateMachineAvailability();
    loadHistory();

    machine.showNotification('Historial limpiado. Los números están disponibles nuevamente', 'success');
}

function formatDateTimeExact(value) {
    if (!value) return '-----';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '-----';
    return date.toLocaleString('es-MX', {
        year: 'numeric',
        month: 'short',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
    });
}

function formatDateShort(value) {
    if (!value) return '-----';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '-----';
    return date.toLocaleDateString('es-MX');
}

function formatTimeShort(value) {
    if (!value) return '-----';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '-----';
    return date.toLocaleTimeString('es-MX', {
        hour: '2-digit',
        minute: '2-digit'
    });
}

function getFechaSorteoRuletazo() {
    if (window.rifaplusConfig?.obtenerFechaSorteoFormato) {
        return window.rifaplusConfig.obtenerFechaSorteoFormato() || 'Por definir';
    }
    return 'Por definir';
}

function getEstadoOrdenMeta(orden) {
    const estado = String(orden?.estado || '').toLowerCase();
    if (estado === 'confirmado' || estado === 'confirmada') {
        return { texto: 'Confirmada', clase: 'confirmada' };
    }
    if (estado === 'apartado' || estado === 'pendiente') {
        return { texto: 'Apartada', clase: 'apartada' };
    }
    if (estado === 'cancelado' || estado === 'cancelada') {
        return { texto: 'Cancelada', clase: 'cancelada' };
    }
    return { texto: estado ? estado.charAt(0).toUpperCase() + estado.slice(1) : 'Disponible', clase: 'disponible' };
}

function buildRuletazoTicketCard({
    ticketNumber,
    numeroFormato,
    orden,
    logoOrganizador,
    nombreSorteo,
    imagenPrincipal
}) {
    const ganadorActual = window.GanadoresManager?.verificarGanador(String(ticketNumber));
    const fechaSorteo = getFechaSorteoRuletazo();
    const estadoMeta = getEstadoOrdenMeta(orden);
    const nombreCompleto = orden
        ? [orden.nombre_cliente, orden.apellido_cliente].filter(Boolean).join(' ').trim() || orden.nombre_cliente || 'N/A'
        : 'N/A';
    const estadoCliente = orden?.estado_cliente || 'N/A';
    const ciudadCliente = orden?.ciudad_cliente || 'N/A';
    const whatsapp = orden?.whatsapp || orden?.telefono_cliente || '';
    const whatsappDigits = String(whatsapp || '').replace(/[^0-9]/g, '');
    const whatsappValido = whatsappDigits.length >= 10;
    const whatsappMasked = whatsappValido ? enmascararTelefonoRuletazo(whatsappDigits) : (whatsappDigits ? 'Inválido' : 'No disponible');
    const whatsappId = `ruletazo-whatsapp-${ticketNumber}-${Date.now()}`;
    const whatsappOnClick = whatsappValido
        ? `abrirWhatsappRuletazo('${whatsappDigits}', '${String(estadoCliente || '').replace(/'/g, "\\'")}')`
        : '';
    const cantidad = orden?.cantidad_boletos || '1';
    const total = orden?.total
        ? `$${Number(orden.total).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
        : 'N/A';
    const fechaCreacionCompleta = orden?.created_at
        ? `${formatDateShort(orden.created_at)} ${formatTimeShort(orden.created_at)}`
        : '-----';
    const fechaComprobanteExacta = formatDateTimeExact(
        orden?.comprobante_fecha || orden?.comprobante_pagado_at
    );
    const ordenId = orden?.numero_orden || orden?.id || 'N/A';
    const disponible = !orden;

    return `
        <div class="ticket-card ticket-card-orden">
            <div class="orden-header-top">
                <div class="orden-header-top-left">
                    <img src="${logoOrganizador}" alt="Logo" onerror="this.src='images/placeholder-logo.svg'">
                    <span class="orden-estado-badge ${disponible ? 'disponible' : estadoMeta.clase}">
                        ${disponible ? 'DISPONIBLE' : estadoMeta.texto.toUpperCase()}
                    </span>
                </div>
                <div class="orden-header-top-right">
                    <div class="orden-id-numero">#${numeroFormato}</div>
                    <div class="orden-fecha-hora">${fechaCreacionCompleta}</div>
                </div>
            </div>

            <div class="orden-nombre-sorteo">${nombreSorteo}</div>

            <div class="orden-imagen-principal">
                <img src="${encodeURI(imagenPrincipal)}" alt="${nombreSorteo}" onerror="this.src='images/placeholder-cover.svg'">
            </div>
            <div class="orden-imagen-fecha-sorteo">
                <span class="orden-imagen-fecha-sorteo-label">Fecha del sorteo</span>
                <span class="orden-imagen-fecha-sorteo-valor">${fechaSorteo}</span>
            </div>

            ${disponible ? `
                <div class="orden-body">
                    <div class="orden-disponible-message">
                        <p>✓ Este boleto está DISPONIBLE</p>
                    </div>
                    <div class="ticket-actions">
                        ${ganadorActual
                            ? `<button class="btn-action btn-ganador" onclick="markAsWinner(${ticketNumber})">
                                <i class="fas fa-check"></i> Desmarcar ganador
                            </button>`
                            : `<button class="btn-action btn-ganador" onclick="markAsWinner(${ticketNumber})">
                                <i class="fas fa-crown"></i> Marcar ganador
                            </button>`
                        }
                    </div>
                </div>
            ` : `
                ${construirPerforacionRuletazo('DATOS DEL PARTICIPANTE')}
                <div class="orden-body">
                    <div class="orden-seccion">
                        <div class="orden-seccion-titulo">👤 Cliente</div>
                        <div class="orden-datos-grid">
                            <div class="orden-dato">
                                <span class="orden-dato-label">Nombre completo</span>
                                <span class="orden-dato-valor">${nombreCompleto}</span>
                            </div>
                            <div class="orden-dato">
                                <span class="orden-dato-label">Estado</span>
                                <span class="orden-dato-valor">${estadoCliente}</span>
                            </div>
                            <div class="orden-dato">
                                <span class="orden-dato-label">Ciudad</span>
                                <span class="orden-dato-valor">${ciudadCliente}</span>
                            </div>
                            <div class="orden-dato orden-dato-full">
                                <span class="orden-dato-label">WhatsApp</span>
                                <div class="whatsapp-toggle-container">
                                    <span
                                        class="orden-dato-valor whatsapp-valor"
                                        id="${whatsappId}"
                                        data-visible="false"
                                        ${whatsappValido ? `onclick="${whatsappOnClick}" style="cursor: pointer; color: #0084ff; text-decoration: underline;"` : 'style="opacity: 0.7;"'}>
                                        ${whatsappMasked}
                                    </span>
                                    <button
                                        type="button"
                                        class="whatsapp-toggle-btn"
                                        data-whatsapp-toggle-id="${whatsappId}"
                                        onclick="toggleWhatsappRuletazo('${whatsappId}', '${String(whatsappDigits).replace(/'/g, "\\'")}')"
                                        title="Mostrar/Ocultar WhatsApp">
                                        <i class="fas fa-eye"></i>
                                    </button>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>

                ${construirPerforacionRuletazo('TALÓN DE CONTROL')}
                <div class="orden-body">
                    <div class="orden-seccion">
                        <div class="orden-seccion-titulo">📋 Orden</div>
                        <div class="orden-datos-grid">
                            <div class="orden-dato">
                                <span class="orden-dato-label">Número de orden</span>
                                <span class="orden-dato-valor">${ordenId}</span>
                            </div>
                            <div class="orden-dato">
                                <span class="orden-dato-label">Estado de la orden</span>
                                <span class="orden-dato-valor"><span class="orden-estado-inline ${estadoMeta.clase}">${estadoMeta.texto}</span></span>
                            </div>
                            <div class="orden-dato">
                                <span class="orden-dato-label">Boletos en la orden</span>
                                <span class="orden-dato-valor">${cantidad}</span>
                            </div>
                            <div class="orden-dato">
                                <span class="orden-dato-label">Total de la orden</span>
                                <span class="orden-dato-valor">${total}</span>
                            </div>
                            <div class="orden-dato">
                                <span class="orden-dato-label">Creada</span>
                                <span class="orden-dato-valor orden-dato-valor-muted">${fechaCreacionCompleta}</span>
                            </div>
                            <div class="orden-dato orden-dato-full">
                                <span class="orden-dato-label">Comprobante subido</span>
                                <span class="orden-dato-valor orden-dato-valor-muted">${fechaComprobanteExacta}</span>
                            </div>
                        </div>
                    </div>

                    <div class="ticket-actions">
                        ${ganadorActual
                            ? `<button class="btn-action btn-ganador" onclick="markAsWinner(${ticketNumber})">
                                <i class="fas fa-check"></i> Desmarcar ganador
                            </button>`
                            : `<button class="btn-action btn-ganador" onclick="markAsWinner(${ticketNumber})">
                                <i class="fas fa-crown"></i> Marcar ganador
                            </button>`
                        }
                    </div>
                </div>
            `}
        </div>
    `;
}

function construirPerforacionRuletazo(texto) {
    return `
        <div class="ticket-perforacion">
            <span class="ticket-perforacion-label">${texto}</span>
        </div>
    `;
}

/**
 * Ve los detalles de un boleto específico
 */
async function viewTicketDetails(ticketNumber) {
    const modal = document.getElementById('ticketModal');
    const modalBody = document.getElementById('ticketModalBody');
    
    modal.classList.add('active');
    modalBody.innerHTML = '<div class="spinner"><i class="fas fa-spinner fa-spin"></i> Cargando...</div>';
    
    try {
        if (window.GanadoresManager?.obtenerGanadorActual) {
            await window.GanadoresManager.obtenerGanadorActual(String(ticketNumber), { preferServer: true, syncLocal: true });
        }

        // Cargar TODAS las órdenes
        const apiBase = (window.rifaplusConfig?.backend?.apiBase)
            || window.rifaplusConfig?.obtenerApiBase?.()
            || window.location.origin;
        const token = localStorage.getItem('rifaplus_admin_token') || localStorage.getItem('admin_token') || '';
        const resOrdenes = await fetch(`${apiBase}/api/ordenes?limit=1000`, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            }
        });
        
        if (!resOrdenes.ok) {
            throw new Error('No se pudieron cargar las órdenes');
        }
        
        const dataOrdenes = await resOrdenes.json();
        const allOrdenes = dataOrdenes.data || [];
        
        // Buscar la orden que contiene este boleto
        let orden = null;
        for (const o of allOrdenes) {
            try {
                // Intentar diferentes formas de acceder a los boletos
                let boletos = [];
                
                if (Array.isArray(o.boletos)) {
                    boletos = o.boletos.map(b => String(Number(b)));
                } else if (typeof o.boletos === 'string') {
                    boletos = JSON.parse(o.boletos).map(b => String(Number(b)));
                }
                
                const ticketStr = String(ticketNumber);
                
                if (boletos.includes(ticketStr) || boletos.includes(String(ticketNumber))) {
                    orden = o;
                    break;
                }
            } catch (e) {
                // Error procesando orden
            }
        }
        
        const config = window.rifaplusConfig || {};
        const logoOrganizador = config.cliente?.logo || 'images/placeholder-logo.svg';
        const nombreSorteo = config.rifa?.nombreSorteo || 'Sorteo';
        const imagenPrincipal =
            config.cliente?.imagenPrincipal ||
            config.rifa?.galeria?.imagenes?.[0]?.url ||
            config.rifa?.imagen ||
            'images/placeholder-cover.svg';
        
        const numeroFormato = machine.formatNumber(ticketNumber, machine.digitCount);
        modalBody.innerHTML = buildRuletazoTicketCard({
            ticketNumber,
            numeroFormato,
            orden,
            logoOrganizador,
            nombreSorteo,
            imagenPrincipal
        });
    } catch (error) {
        // Error cargando detalles del boleto
        modalBody.innerHTML = `
            <div class="alert alert-danger">
                <i class="fas fa-exclamation-circle"></i>
                Error: ${error.message}
            </div>
        `;
    }
}

/**
 * Cierra el modal
 */
function closeTicketModal() {
    document.getElementById('ticketModal').classList.remove('active');
}

/**
 * Marca boleto como ganador
 */
async function markAsWinner(ticketNumber) {
    if (!confirm(`¿Confirmar que el boleto ${ticketNumber} es el ganador?`)) {
        return;
    }
    
    try {
        const apiBase = (window.rifaplusConfig?.backend?.apiBase)
            || window.rifaplusConfig?.obtenerApiBase?.()
            || window.location.origin;
        const token = localStorage.getItem('rifaplus_admin_token') || localStorage.getItem('admin_token') || '';
        const response = await fetch(`${apiBase}/api/admin/boleto/${ticketNumber}/ganador`, {
            method: 'PATCH',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ ganador: true })
        });
        
        if (!response.ok) {
            throw new Error(`Error ${response.status}`);
        }
        
        machine.showNotification('✅ Boleto marcado como ganador', 'success');
        setTimeout(() => viewTicketDetails(ticketNumber), 500);
    } catch (error) {
        machine.showNotification(`❌ Error: ${error.message}`, 'error');
    }
}

/**
 * ===== FUNCIONES PARA GANADORES =====
 */

/**
 * Marcar número ganador como tal
 * @param {Number} numero - Número del boleto ganador
 */
window.markAsWinner = async function(numero) {
    if (!window.GanadoresManager) {
        if (window.machine) {
            window.machine.showNotification('❌ Sistema de ganadores no disponible', 'error');
        } else {
            alert('❌ Sistema de ganadores no disponible');
        }
        return;
    }

    // Validar número
    numero = String(numero).trim();
    if (!numero || isNaN(numero)) {
        if (window.machine) {
            window.machine.showNotification('❌ Número de boleto inválido', 'error');
        } else {
            alert('❌ Número de boleto inválido');
        }
        return;
    }

    // Verificar si ya es ganador
    const ganadorExistente = await window.GanadoresManager.obtenerGanadorActual(numero, { preferServer: true, syncLocal: true });
    if (ganadorExistente) {
        // Es ganador, mostrar opción para desmarcar
        const confirmar = confirm(`✅ Este boleto ya es ganador de ${ganadorExistente.tipo}.\n\n¿Deseas desmarcarlo como ganador?`);
        if (confirmar) {
            window.eliminarGanadorBackend(numero, ganadorExistente.tipo);
        }
        return;
    }

    // Extraer datos del cliente desde el modal
    const modalBody = document.getElementById('ticketModalBody');
    let datosCliente = {
        nombre: '',
        apellido: '',
        ciudad: '',
        estado_cliente: ''
    };

    if (modalBody) {
        // Buscar todos los divs y extraer los datos por su contenido de texto
        const allDivs = Array.from(modalBody.querySelectorAll('div'));
        
        // Buscar contenedores con estilo de fondo grisáceo que contienen Nombre, Estado, Ciudad
        allDivs.forEach((el) => {
            const labelDiv = el.querySelector('div:first-child');
            const valueDiv = el.querySelector('div:last-child');
            
            if (labelDiv && valueDiv) {
                const labelText = labelDiv.textContent.trim().toUpperCase();
                const value = valueDiv.textContent.trim();
                
                if (labelText === 'NOMBRE' && value !== 'NOMBRE') {
                    // Separar nombre y apellido si contiene espacio
                    const partes = value.split(' ');
                    datosCliente.nombre = partes[0] || '';
                    datosCliente.apellido = partes.slice(1).join(' ') || '';
                } else if (labelText === 'ESTADO' && value !== 'ESTADO') {
                    datosCliente.estado_cliente = value;
                } else if (labelText === 'CIUDAD' && value !== 'CIUDAD') {
                    datosCliente.ciudad = value;
                }
            }
        });
    }

    // Abrir modal para seleccionar tipo de ganador
    window.abrirModalSeleccionarGanador(numero, datosCliente, function(numeroGanador, tipoGanador, exito) {
        if (exito) {
            if (window.machine) {
            }
            // Recargar modal después de 1 segundo
            setTimeout(() => {
                window.location.reload();
            }, 1000);
        }
    });
};

window.declararGanadorBackend = async function(numero, tipoGanador, lugarGanado) {
    const apiBase = (window.rifaplusConfig?.backend?.apiBase)
        || window.rifaplusConfig?.obtenerApiBase?.()
        || window.location.origin;
    const token = localStorage.getItem('rifaplus_admin_token') || localStorage.getItem('admin_token') || '';

    // ⚠️ CRÍTICO: Obtener rifa seleccionada para aislamiento multirifa
    // Intentar 1: localStorage (más confiable)
    let rifaIdSeleccionada = null;
    try {
        const stored = localStorage.getItem('rifaplus_rifa_activa');
        if (stored) {
            const parsed = Number.parseInt(stored, 10);
            if (Number.isInteger(parsed) && parsed > 0) {
                rifaIdSeleccionada = parsed;
            }
        }
    } catch (e) {
        // localStorage no disponible
    }
    
    // Intentar 2: ADMIN_LAYOUT (nombre correcto en admin-layout.js)
    if (!rifaIdSeleccionada && typeof window.ADMIN_LAYOUT?.getActiveRifaId?.() === 'number') {
        rifaIdSeleccionada = window.ADMIN_LAYOUT.getActiveRifaId();
    }

    // ⚠️ VALIDACIÓN CRÍTICA: Debe haber una rifa seleccionada
    if (!rifaIdSeleccionada) {
        console.error('❌ [Ruletazo] ERROR: No hay rifa seleccionada para declarar ganador');
        throw new Error('No hay rifa seleccionada. Por favor, selecciona una rifa en el selector admin.');
    }

    console.log(`🎡 [Ruletazo] Declarando ganador #${numero} como ${tipoGanador} en rifa_id=${rifaIdSeleccionada}`);

    const response = await fetch(`${apiBase}/api/admin/declarar-ganador`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
            // ⚠️ ENVIAR HEADER X-Rifa-Id PARA AISLAMIENTO
            'X-Rifa-Id': String(rifaIdSeleccionada)
        },
        body: JSON.stringify({
            numero: Number(numero),
            tipo_ganador: tipoGanador,
            posicion: Number(lugarGanado)
        })
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
        console.error(`❌ [Ruletazo] Error declarando ganador:`, payload);
        throw new Error(payload.error || payload.message || `Error ${response.status}`);
    }

    console.log(`✅ [Ruletazo] Ganador #${numero} declarado exitosamente en rifa_id=${rifaIdSeleccionada}`);
    return payload;
};

window.eliminarGanadorBackend = async function(numero, tipoGanador = null) {
    try {
        const apiBase = (window.rifaplusConfig?.backend?.apiBase)
            || window.rifaplusConfig?.obtenerApiBase?.()
            || window.location.origin;
        const token = localStorage.getItem('rifaplus_admin_token') || localStorage.getItem('admin_token') || '';

        // ⚠️ CRÍTICO: Obtener rifa seleccionada para aislamiento multirifa
        let rifaIdSeleccionada = null;
        try {
            const stored = localStorage.getItem('rifaplus_rifa_activa');
            if (stored) {
                const parsed = Number.parseInt(stored, 10);
                if (Number.isInteger(parsed) && parsed > 0) {
                    rifaIdSeleccionada = parsed;
                }
            }
        } catch (e) {
            // localStorage no disponible
        }

        const headers = {
            'Authorization': `Bearer ${token}`
        };
        
        if (rifaIdSeleccionada) {
            headers['X-Rifa-Id'] = String(rifaIdSeleccionada);
        }

        const response = await fetch(`${apiBase}/api/admin/ganadores/${encodeURIComponent(numero)}`, {
            method: 'DELETE',
            headers
        });

        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
            throw new Error(payload.message || `Error ${response.status}`);
        }

        if (window.GanadoresManager && tipoGanador) {
            window.GanadoresManager.eliminarGanador(String(numero), tipoGanador);
        }

        if (window.machine) {
            window.machine.showNotification(`✅ Boleto #${numero} desmarcado como ganador`, 'success');
        } else {
            alert(`✅ Boleto #${numero} desmarcado como ganador`);
        }

        setTimeout(() => {
            window.location.reload();
        }, 500);
    } catch (error) {
        if (window.machine) {
            window.machine.showNotification(`❌ ${error.message}`, 'error');
        } else {
            alert(`❌ ${error.message}`);
        }
    }
};
