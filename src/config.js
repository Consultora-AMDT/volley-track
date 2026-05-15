// ⚠️ Ajusta estos valores antes de desplegar.
// Estos son los canales por los que los padres te enviarán sugerencias.

export const APP_VERSION = '1.2.0';

export const FEEDBACK = {
  // Tu número de WhatsApp con código de país, SIN "+", espacios ni guiones
  // Ejemplo: '34600123456' para España
  whatsapp: '34610633398',

  // Tu email donde quieres recibir sugerencias
  email: 'contacto@aunmasdificiltodavia.es',
};

// Límites de input — endurece contra abuso/quota localStorage
export const LIMITS = {
  teamNameMax: 40,
  playerNameMax: 30,
  locationMax: 60,
  feedbackMax: 1000,
};
