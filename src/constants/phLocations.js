// Philippines province → cities/municipalities dataset
// Source: Philippine Statistics Authority (PSA) — Philippine Standard Geographic Code (PSGC)
// Service areas: Bohol, Metro Manila, Cavite, Batangas, Laguna, Bulacan
// Used by: RegisterPage, BookShipmentPage, PersonalInfoPage, database.js

export const PH_LOCATIONS = {
  'Batangas': [
    'Agoncillo',
    'Alitagtag',
    'Balayan',
    'Balete',
    'Batangas City',
    'Bauan',
    'Calaca',
    'Calatagan',
    'Cuenca',
    'Ibaan',
    'Laurel',
    'Lemery',
    'Lian',
    'Lipa',
    'Lobo',
    'Mabini',
    'Malvar',
    'Mataasnakahoy',
    'Nasugbu',
    'Padre Garcia',
    'Rosario',
    'San Jose',
    'San Juan',
    'San Luis',
    'San Nicolas',
    'San Pascual',
    'Santa Teresita',
    'Santo Tomas',
    'Taal',
    'Talisay',
    'Tanauan',
    'Taysan',
    'Tingloy',
    'Tuy',
  ],
  'Bohol': [
    'Alburquerque',
    'Alicia',
    'Anda',
    'Antequera',
    'Baclayon',
    'Balilihan',
    'Batuan',
    'Bien Unido',
    'Bilar',
    'Buenavista',
    'Calape',
    'Candijay',
    'Carmen',
    'Catigbian',
    'Clarin',
    'Corella',
    'Cortes',
    'Dagohoy',
    'Danao',
    'Dauis',
    'Dimiao',
    'Duero',
    'Garcia Hernandez',
    'Getafe',
    'Guindulman',
    'Inabanga',
    'Jagna',
    'Lila',
    'Loay',
    'Loboc',
    'Loon',
    'Mabini',
    'Maribojoc',
    'Panglao',
    'Pilar',
    'President Carlos P. Garcia',
    'Sagbayan',
    'San Isidro',
    'San Miguel',
    'Sevilla',
    'Sierra Bullones',
    'Sikatuna',
    'Tagbilaran City',
    'Talibon',
    'Trinidad',
    'Tubigon',
    'Ubay',
    'Valencia',
  ],
  'Bulacan': [
    'Angat',
    'Balagtas',
    'Baliuag',
    'Bocaue',
    'Bulakan',
    'Bustos',
    'Calumpit',
    'Doña Remedios Trinidad',
    'Guiguinto',
    'Hagonoy',
    'Malolos',
    'Marilao',
    'Meycauayan',
    'Norzagaray',
    'Obando',
    'Pandi',
    'Paombong',
    'Plaridel',
    'Pulilan',
    'San Ildefonso',
    'San Jose del Monte',
    'San Miguel',
    'San Rafael',
    'Santa Maria',
  ],
  'Cavite': [
    'Alfonso',
    'Amadeo',
    'Bacoor',
    'Carmona',
    'Cavite City',
    'Dasmariñas',
    'General Emilio Aguinaldo',
    'General Mariano Alvarez',
    'General Trias',
    'Imus',
    'Indang',
    'Kawit',
    'Magallanes',
    'Maragondon',
    'Mendez',
    'Naic',
    'Noveleta',
    'Rosario',
    'Silang',
    'Tagaytay',
    'Tanza',
    'Ternate',
    'Trece Martires',
  ],
  'Laguna': [
    'Alaminos',
    'Bay',
    'Biñan',
    'Cabuyao',
    'Calamba',
    'Calauan',
    'Cavinti',
    'Famy',
    'Kalayaan',
    'Liliw',
    'Los Baños',
    'Luisiana',
    'Lumban',
    'Mabitac',
    'Magdalena',
    'Majayjay',
    'Nagcarlan',
    'Paete',
    'Pagsanjan',
    'Pakil',
    'Pangil',
    'Pila',
    'Rizal',
    'San Pablo',
    'San Pedro',
    'Santa Cruz',
    'Santa Maria',
    'Santa Rosa',
    'Siniloan',
    'Victoria',
  ],
  'Metro Manila': [
    'Caloocan',
    'Las Piñas',
    'Makati',
    'Malabon',
    'Mandaluyong',
    'Manila',
    'Marikina',
    'Muntinlupa',
    'Navotas',
    'Parañaque',
    'Pasay',
    'Pasig',
    'Pateros',
    'Quezon City',
    'San Juan',
    'Taguig',
    'Valenzuela',
  ],
};

export const VALID_PROVINCES = Object.keys(PH_LOCATIONS).sort();

/**
 * Returns true when the province/city combination is valid.
 * Empty/null for either field means "not yet provided" → passes.
 */
export const isValidProvinceCity = (province, city) => {
  if (!province) return true;
  if (!VALID_PROVINCES.includes(province)) return false;
  if (!city) return true;
  return (PH_LOCATIONS[province] || []).includes(city);
};

// ── Route Detection ──────────────────────────────────────────────
// Classifies a province as 'bohol' or 'manila' for route validation.
// "Manila side" = Metro Manila, Cavite, Batangas, Laguna, Bulacan
// "Bohol side"  = Bohol only

const BOHOL_PROVINCES = ['Bohol'];
const MANILA_PROVINCES = ['Metro Manila', 'Cavite', 'Batangas', 'Laguna', 'Bulacan'];

/**
 * Detects which route side a province belongs to.
 * @param {string} province - Exact province name from dropdown
 * @returns {'bohol'|'manila'|null}
 */
export const detectPickupLocation = (province) => {
  if (!province) return null;
  if (BOHOL_PROVINCES.includes(province)) return 'bohol';
  if (MANILA_PROVINCES.includes(province)) return 'manila';
  if (province === 'Other Area') return 'other';
  return null;
};

/**
 * Validates sender/receiver province against the selected route.
 * @param {string} senderProvince - Sender's province
 * @param {string} receiverProvince - Receiver's province (if available)
 * @param {object} route - { origin, destination } e.g. { origin: 'Bohol', destination: 'Manila' }
 * @returns {{ valid: boolean, error?: string }}
 */
export const validateRouteProvinces = (senderProvince, receiverProvince, route) => {
  if (!route) return { valid: false, error: 'Please select a route first.' };

  const senderSide = detectPickupLocation(senderProvince);
  const receiverSide = detectPickupLocation(receiverProvince);

  // Bohol → Manila route: sender must be Bohol, receiver must be Manila side
  if (route.origin === 'Bohol') {
    if (senderProvince && senderSide !== 'bohol' && senderSide !== 'other') {
      return { valid: false, error: `Sender must be from Bohol for route "${route.origin} → ${route.destination}". You selected "${senderProvince}".` };
    }
    if (receiverProvince && receiverSide !== 'manila') {
      return { valid: false, error: `Receiver must be from Metro Manila, Cavite, Batangas, Laguna, or Bulacan for route "${route.origin} → ${route.destination}". You selected "${receiverProvince}".` };
    }
  }

  // Manila → Bohol route: sender must be Manila side, receiver must be Bohol
  if (route.origin === 'Manila') {
    if (senderProvince && senderSide !== 'manila' && senderSide !== 'other') {
      return { valid: false, error: `Sender must be from Metro Manila, Cavite, Batangas, Laguna, or Bulacan for route "${route.origin} → ${route.destination}". You selected "${senderProvince}".` };
    }
    if (receiverProvince && receiverSide !== 'bohol') {
      return { valid: false, error: `Receiver must be from Bohol for route "${route.origin} → ${route.destination}". You selected "${receiverProvince}".` };
    }
  }

  return { valid: true };
};

// Available routes
export const ROUTES = [
  { origin: 'Bohol', destination: 'Manila', label: 'Bohol → Manila' },
  { origin: 'Manila', destination: 'Bohol', label: 'Manila → Bohol' },
];
