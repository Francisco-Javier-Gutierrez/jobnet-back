const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, PutCommand, ScanCommand } = require("@aws-sdk/lib-dynamodb");
const crypto = require("crypto");

const client = new DynamoDBClient({ region: "us-east-1" });
const docClient = DynamoDBDocumentClient.from(client);

const TableName = "jobnet-jobs-prod";

const jobTemplates = [
  {
    titulo: "Desarrollador Full Stack Jr",
    descripcion: "Buscamos un desarrollador entusiasta para unirse a nuestro equipo de producto.",
    modalidad: "Remoto",
    salarioMinimo: 15000,
    salarioMaximo: 25000,
    habilidadesRequeridas: ["React", "Node.js", "TypeScript"],
    sectores: ["Tecnología", "Desarrollo de Software"],
    experienciaAnos: 1,
  },
  {
    titulo: "Ingeniero de Datos Semi-Senior",
    descripcion: "Únete al equipo de datos para diseñar pipelines escalables.",
    modalidad: "Híbrido",
    salarioMinimo: 30000,
    salarioMaximo: 45000,
    habilidadesRequeridas: ["Python", "SQL", "AWS"],
    sectores: ["Inteligencia Artificial", "Big Data"],
    experienciaAnos: 3,
  },
  {
    titulo: "Especialista en Marketing Digital",
    descripcion: "Encargado de la estrategia de inbound y campañas pagadas.",
    modalidad: "Presencial",
    salarioMinimo: 18000,
    salarioMaximo: 28000,
    habilidadesRequeridas: ["Google Ads", "SEO", "Copywriting"],
    sectores: ["Marketing Digital", "Publicidad"],
    experienciaAnos: 2,
  },
];

async function seedVacancies() {
  try {
    // Fetch companies
    const scanResult = await docClient.send(
      new ScanCommand({
        TableName,
        FilterExpression: "tipoUsuario = :t",
        ExpressionAttributeValues: {
          ":t": "ORGANIZACION",
        },
      }),
    );

    const companies = scanResult.Items || [];
    console.log(`Found ${companies.length} organizations.`);

    for (const company of companies) {
      const empresaUuid = company.PK.replace("USER#", "");
      const companyName = company.nombreComercial || "Empresa";

      // Select 2 random job templates
      const selectedJobs = jobTemplates.sort(() => 0.5 - Math.random()).slice(0, 2);

      for (const job of selectedJobs) {
        const vacancyUuid = crypto.randomUUID();
        const now = new Date().toISOString();

        const item = {
          PK: `VACANCY#${vacancyUuid}`,
          SK: "METADATA",
          GSI1PK: "VACANCIES",
          GSI1SK: now,
          empresaUuid,
          company: companyName,
          titulo: job.titulo,
          descripcion: job.descripcion,
          modalidad: job.modalidad,
          salario: job.salarioMaximo,
          salarioMinimo: job.salarioMinimo,
          salarioMaximo: job.salarioMaximo,
          habilidadesRequeridas: job.habilidadesRequeridas,
          sectores: job.sectores,
          aptitudes: "",
          experienciaAnos: job.experienciaAnos,
          ubicacion: {
            lat: 19.432608,
            lng: -99.133209,
            name: company.ubicacion || "Ciudad de México",
          },
          lat: 19.432608,
          lng: -99.133209,
          pdfUrl: "",
          vacantesDisponibles: Math.floor(Math.random() * 3) + 1,
          maxPostulantes: 50,
          estado: "Activa",
          fechaCreacion: now,
          updatedAt: now,
        };

        await docClient.send(
          new PutCommand({
            TableName,
            Item: item,
          }),
        );
        console.log(`Created job "${job.titulo}" for company "${companyName}"`);
      }
    }

    console.log("Successfully seeded vacancies.");
  } catch (err) {
    console.error("Error seeding vacancies:", err);
  }
}

seedVacancies();
