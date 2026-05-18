// ⚠️ Ajusta estos valores antes de desplegar.
// Estos son los canales por los que los padres te enviarán sugerencias.

export const APP_VERSION = '1.4.6';

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

// Plantilla preconfigurada del cole, ordenada por dorsal.
// Para añadir/quitar jugadoras, edita este array.
// Al crear un partido se ofrece cargar esta plantilla con un solo botón.
export const SANTA_ANA_ROSTER = [
  { name: 'María Carrasco', number: 2 },
  { name: 'Paula H', number: 3 },
  { name: 'Lucia', number: 5 },
  { name: 'Alicia', number: 7 },
  { name: 'Ximena', number: 8 },
  { name: 'Lidia', number: 10 },
  { name: 'Marina', number: 12 },
  { name: 'Guillermo', number: 14 },
  { name: 'Paula J', number: 16 },
  { name: 'Inés', number: 19 },
  { name: 'Irati', number: 27 },
];

// Nombres del equipo local que activan la plantilla precargada.
// Si el equipo A contiene alguno de estos textos (case-insensitive),
// se mostrará el botón para cargar la plantilla del cole.
export const HOME_TEAM_ALIASES = ['santa ana', 'san rafael', 'sr', 'sa'];

