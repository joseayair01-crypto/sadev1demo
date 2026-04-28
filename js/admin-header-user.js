/**
 * Admin Header User Info - Script centralizado
 * Se carga en TODAS las páginas admin para mostrar información del usuario
 * Inyecta el HTML si no existe y mantiene sincronizado con JWT
 */

(function() {
    'use strict';

    function debugAdminHeader() {
        let enabled = window.RIFAPLUS_DEBUG_ADMIN === true;

        if (!enabled) {
            try {
                enabled = localStorage.getItem('rifaplus_debug_admin') === 'true';
            } catch (error) {
                enabled = false;
            }
        }

        if (enabled && typeof console !== 'undefined' && typeof console.debug === 'function') {
            console.debug('[AdminHeader]', ...arguments);
        }
    }
    
    /**
     * Decodificar JWT (busca en múltiples claves posibles)
     */
    function decodificarTokenJWT() {
        // Buscar token en múltiples ubicaciones posibles
        const token = localStorage.getItem('rifaplus_token') || 
                      localStorage.getItem('rifaplus_admin_token') ||
                      localStorage.getItem('admin_token') ||
                      localStorage.getItem('adminToken') ||
                      localStorage.getItem('token');
        
        if (!token) {
            debugAdminHeader('No hay token en localStorage');
            return null;
        }

        try {
            const partes = token.split('.');
            if (partes.length !== 3) {
                console.error('[AdminHeader] Token JWT inválido (estructura incorrecta)');
                return null;
            }

            // Decodificar payload (parte 2)
            const payload = partes[1];
            const decoded = JSON.parse(atob(payload));
            debugAdminHeader('Token decodificado', decoded);
            return decoded;
        } catch (error) {
            console.error('[AdminHeader] Error decodificando JWT:', error);
            return null;
        }
    }

    /**
     * Inyectar HTML del user-info si no existe
     */
    function inyectarUserInfo() {
        const headerRight = document.querySelector('.admin-header-right');
        if (!headerRight) {
            console.warn('No se encontró .admin-header-right');
            return;
        }

        // Verificar si ya existe
        if (document.getElementById('userInfoContainer')) {
            return; // Ya existe
        }

        // Crear HTML del user-info
        const userInfoHTML = `
            <div class="admin-user-info" id="userInfoContainer">
                <div class="admin-user-avatar">
                    <i class="fas fa-user-circle"></i>
                </div>
                <div class="admin-user-details">
                    <div class="admin-user-name" id="userDisplayName">-</div>
                    <div class="admin-user-role" id="userDisplayRole" style="font-size: 0.75rem; opacity: 0.7;">-</div>
                </div>
            </div>
        `;

        // Insertar ANTES del logout button
        const logoutBtn = headerRight.querySelector('.admin-logout-btn');
        if (logoutBtn) {
            logoutBtn.insertAdjacentHTML('beforebegin', userInfoHTML);
        } else {
            // Si no hay logout, insertar al inicio
            headerRight.insertAdjacentHTML('afterbegin', userInfoHTML);
        }
    }

    /**
     * Llenar información del usuario desde JWT
     * Más robusto - espera a que el DOM esté listo si es necesario
     */
    function llenarUsuarioEnHeader() {
        const tryFill = () => {
            const usuario = decodificarTokenJWT();
            
            const nombreDisplay = document.getElementById('userDisplayName');
            const rolDisplay = document.getElementById('userDisplayRole');

            if (!nombreDisplay || !rolDisplay) {
                // Si los elementos no existen aún, reintentar en 100ms
                if (!usuario) {
                    debugAdminHeader('No se pudo decodificar usuario porque el usuario no esta autenticado');
                    return;
                }
                setTimeout(tryFill, 100);
                return;
            }

            if (!usuario) {
                if (nombreDisplay) nombreDisplay.textContent = 'No autenticado';
                if (rolDisplay) rolDisplay.textContent = 'Sin rol';
                return;
            }

            if (nombreDisplay) {
                nombreDisplay.textContent = usuario.username || 'Usuario';
            }
            
            if (rolDisplay) {
                // ✅ Mapeo consistente de roles
                const rolMensaje = usuario.rol === 'administrador' 
                    ? 'Administrador' 
                    : (usuario.rol === 'gestor_ordenes' ? 'Gestor de Órdenes' : 'Usuario');
                rolDisplay.textContent = rolMensaje;
            }
        };
        
        tryFill();
    }

    /**
     * Inicializar: Inyectar y llenar
     */
    function inicializar() {
        // Esperar a que el DOM esté listo
        const ejecutar = () => {
            inyectarUserInfo();
            llenarUsuarioEnHeader();
        };

        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', ejecutar);
        } else {
            // DOM ya listo
            ejecutar();
        }
    }

    /**
     * Exponer función para actualizar el header después del login
     * Se llama desde admin-dashboard.js después de hacer login
     */
    window.AdminHeaderManager = {
        reload: function() {
            debugAdminHeader('Recargando informacion de usuario');
            llenarUsuarioEnHeader();
        }
    };

    // Ejecutar al cargar el script
    inicializar();

    // Escuchar cambios en el token (para sincronizar entre pestañas)
    window.addEventListener('storage', (evento) => {
        if (evento.key?.includes('token')) {
            debugAdminHeader('Token cambio en storage; actualizando usuario');
            llenarUsuarioEnHeader();
        }
    });

    // Exponerlo globalmente para que otras scripts puedan acceder si es necesario
    window.AdminHeaderUser = {
        decodificarTokenJWT,
        llenarUsuarioEnHeader,
        inyectarUserInfo
    };
})();
