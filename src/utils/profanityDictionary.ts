/**
 * Diccionario maestro de palabras ofensivas, acrónimos, términos de odio y patrones fraudulentos
 * categorizados para el filtro determinístico Nivel 0 de JobNet.
 */

export interface BlacklistCategory {
  id: string;
  name: string;
  severity: "ALTA" | "MEDIA" | "CRITICA";
  terms: string[];
}

export const ACRONYMS_LIST = [
  "sybau", // shut your bitch ass up
  "vtalv", // vete a la verga
  "alv", // a la verga
  "chsm", // chinga tu santa madre
  "ctm", // chinga tu madre
  "cdtm", // concha de tu madre
  "hdp", // hijo de puta
  "ptm", // puta madre
  "mlparido", // malparido
  "stfu", // shut the fuck up
  "gtfo", // get the fuck out
  "kys", // kill yourself
  "sob", // son of a bitch
  "lpmqtp", // la puta madre que te pario
  "plmdr", // puta la madre
  "vtlv", // vete a la verga
  "csm", // chinga su madre
  "alch", // a la chingada
];

export const PROFANITY_MX_LIST = [
  "pendejo",
  "pendeja",
  "pendejada",
  "pendejos",
  "pendejas",
  "verga",
  "vergas",
  "vergazo",
  "verguiza",
  "verguita",
  "chingar",
  "chingada",
  "chingado",
  "chingados",
  "chingon",
  "chingadera",
  "chingaderas",
  "chingue",
  "chingas",
  "chingamos",
  "chingate",
  "puto",
  "puta",
  "putita",
  "puton",
  "putos",
  "putas",
  "culero",
  "culera",
  "culeros",
  "culeras",
  "mamon",
  "mamona",
  "mamones",
  "mamadas",
  "mamada",
  "cabron",
  "cabrona",
  "cabrones",
  "pinche",
  "pinches",
  "mierda",
  "mierdas",
  "zorra",
  "zorras",
  "perra",
  "perras",
  "perro sarnoso",
  "bastardo",
  "bastarda",
  "malnacido",
  "malnacida",
  "estupido",
  "estupida",
  "estupidos",
  "imbecil",
  "imbeciles",
  "tarado",
  "tarada",
  "idiota",
  "idiotas",
  "marica",
  "maricon",
  "maricones",
  "joto",
  "jotos",
  "jotolon",
  "puñetas",
  "punetas",
  "webon",
  "guevon",
  "huevon",
  "ojete",
  "ojetes",
  "culito",
  "panocha",
];

export const HATE_SPEECH_LIST = [
  "prieto",
  "prietos",
  "prieta",
  "naco",
  "nacos",
  "naca",
  "nacas",
  "sudaca",
  "sudacas",
  "negro de mierda",
  "negros de mierda",
  "marimacha",
  "tortillera",
  "sidoso",
  "sidosa",
  "feminazi",
  "feminazis",
  "machirulo",
  "machirulos",
  "limpieza etnica",
  "supremacia blanca",
  "indio de mierda",
  "muerte a los",
  "subnormal",
  "retrasado mental",
  "faggot",
  "faggots",
  "nigger",
  "niggers",
  "nigga",
  "niggas",
  "kike",
  "chink",
  "tranny",
];

export const PROFANITY_EN_LIST = [
  "bitch",
  "bitches",
  "asshole",
  "assholes",
  "fuck",
  "fucking",
  "fucker",
  "motherfucker",
  "cunt",
  "cunts",
  "whore",
  "whores",
  "slut",
  "sluts",
  "retard",
  "retards",
  "dickhead",
  "pussy",
  "pussies",
  "bullshit",
  "blowjob",
  "jackass",
  "dipshit",
];

export const SCAM_PATTERNS_LIST = [
  "se tu propio jefe",
  "inversion inicial requerida",
  "deposito para uniforme",
  "gane en dolares desde casa",
  "trading forex garantizado",
  "esquema multinivel",
  "gana dinero facil sin experiencia",
  "deposite para asegurar su puesto",
];

export const SEXUAL_CONTENT_LIST = [
  "sexo anal",
  "sexo oral",
  "sexo casual",
  "servicios sexuales",
  "anal",
  "pornografia",
  "porno",
  "coito",
  "felacion",
  "prostitucion",
  "prostituta",
  "prostituto",
  "escort",
  "scort",
  "nopor",
  "pack de fotos",
  "fotos intimas",
  "masturbacion",
  "pene",
  "vagina",
  "follar",
  "blowjob",
  "handjob",
  "cumshot",
  "hardcore porn",
];

export const PROFANITY_CATEGORIES: BlacklistCategory[] = [
  {
    id: "ACRONYMS",
    name: "Acrónimos Ofensivos y Jerga de Internet",
    severity: "ALTA",
    terms: ACRONYMS_LIST,
  },
  {
    id: "HATE_SPEECH",
    name: "Discurso de Odio y Discriminación",
    severity: "CRITICA",
    terms: HATE_SPEECH_LIST,
  },
  {
    id: "PROFANITY_MX",
    name: "Insultos y Vulgaridades (Español / México)",
    severity: "ALTA",
    terms: PROFANITY_MX_LIST,
  },
  {
    id: "PROFANITY_EN",
    name: "Insultos y Ofensas en Inglés",
    severity: "ALTA",
    terms: PROFANITY_EN_LIST,
  },
  {
    id: "SCAM_JOB",
    name: "Patrones de Fraude y Estafas Laborales",
    severity: "CRITICA",
    terms: SCAM_PATTERNS_LIST,
  },
  {
    id: "SEXUAL_CONTENT",
    name: "Contenido Sexual y Adulto Inapropiado",
    severity: "CRITICA",
    terms: SEXUAL_CONTENT_LIST,
  },
];
