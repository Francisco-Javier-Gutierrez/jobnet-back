const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, PutCommand } = require("@aws-sdk/lib-dynamodb");
const crypto = require("crypto");

// Configurar DynamoDB client usando el perfil adecuado
const client = new DynamoDBClient({ region: "us-east-1" });
const docClient = DynamoDBDocumentClient.from(client);

const TableName = "jobnet-jobs-prod";

const companies = [
  {
    nombreComercial: "TechSolutions Inc.",
    razonSocial: "TechSolutions S.A. de C.V.",
    logo: "https://lh3.googleusercontent.com/aida-public/AB6AXuDSzjpaT0Ede7QLy3zl1zft4f4V9csQyhGIsAyNHyyg4lmk54ha7yMkfDw5hbVoBOME8PTGFax9iKrHHZjAmqwMRA4i1UpqhgebzJGIkwq1DS6PKK1G5jxCNSxxPjHi_ezhM-ik2qaFtqa9JYp6ruPrCozHQM4UvsZpk2HUAg07aFTdAk58De2NTtSjHaO49ddhrtHPFA-trQm7WZbFMHwS-NZ7jyJ7ZrGaZD9yxWogET6EbwJ_H8Tk0g",
    sector: "Desarrollo de Software y Cloud Computing",
    biografia: "Empresa tecnológica especializada en desarrollo cloud y arquitectura de microservicios.",
    organizacionVerificada: true,
    ubicacion: "Ciudad de México, MX",
    email: "contacto@techsolutions.mx"
  },
  {
    nombreComercial: "InnovaTech Global",
    razonSocial: "InnovaTech Global Solutions S. de R.L.",
    logo: "https://images.unsplash.com/photo-1542744094-3a31b272c490?w=150&auto=format&fit=crop&q=80",
    sector: "Inteligencia Artificial & Ciencia de Datos",
    biografia: "Líder en soluciones de inteligencia artificial aplicada a finanzas y retail.",
    organizacionVerificada: true,
    ubicacion: "Guadalajara, JAL, MX",
    email: "hello@innovatech.global"
  },
  {
    nombreComercial: "Grupo Financiero Prisma",
    razonSocial: "Prisma Financial Group S.A.B.",
    logo: "https://images.unsplash.com/photo-1551836022-d5d88e9218df?w=150&auto=format&fit=crop&q=80",
    sector: "Banca, Finanzas y Fintech",
    biografia: "Institución financiera con presencia latinoamericana focalizada en inclusión digital.",
    organizacionVerificada: true,
    ubicacion: "Monterrey, N.L., MX",
    email: "rrhh@prismagroup.com"
  },
  {
    nombreComercial: "BioSalud México",
    razonSocial: "Laboratorios BioSalud Innovación S.A.",
    logo: "https://images.unsplash.com/photo-1532938911079-1b06ac7ceec7?w=150&auto=format&fit=crop&q=80",
    sector: "Biotecnología y Salud",
    biografia: "Desarrollo de biotecnología avanzada y equipamiento médico inteligente.",
    organizacionVerificada: false,
    ubicacion: "Querétaro, QRO, MX",
    email: "talento@biosalud.mx"
  },
  {
    nombreComercial: "Starlight Logistics",
    razonSocial: "Starlight Cargo & Supply Chain S.A. de C.V.",
    logo: "https://images.unsplash.com/photo-1586528116311-ad8dd3c8310d?w=150&auto=format&fit=crop&q=80",
    sector: "Logística y Cadena de Suministro",
    biografia: "Operaciones logísticas internacionales con seguimiento automatizado e IoT.",
    organizacionVerificada: true,
    ubicacion: "Puebla, PUE, MX",
    email: "careers@starlightlogistics.com"
  },
  {
    nombreComercial: "Pixel & Code Studio",
    razonSocial: "Pixel Code Digital Agency S.C.",
    logo: "https://images.unsplash.com/photo-1572021335469-31706a17aaef?w=150&auto=format&fit=crop&q=80",
    sector: "Diseño UX/UI & Marketing Digital",
    biografia: "Estudio creativo centrado en experiencia de usuario y desarrollo web a medida.",
    organizacionVerificada: false,
    ubicacion: "Mérida, YUC, MX",
    email: "jobs@pixelcode.studio"
  }
];

async function seed() {
  for (const company of companies) {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    
    const item = {
      PK: `USER#${id}`,
      SK: "PROFILE",
      tipoUsuario: "ORGANIZACION",
      fechaCreacion: now,
      fechaActualizacion: now,
      updatedAt: now,
      estadoCuenta: "ACTIVO",
      estatus: "Activa",
      estatusVerificacion: company.organizacionVerificada ? "Verificada" : "Pendiente",
      ...company
    };

    try {
      await docClient.send(new PutCommand({
        TableName,
        Item: item
      }));
      console.log(`Successfully added ${company.nombreComercial}`);
    } catch (err) {
      console.error(`Error adding ${company.nombreComercial}:`, err);
    }
  }
}

seed();
