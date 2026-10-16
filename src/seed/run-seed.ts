import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';
import { seedPackage } from './seed-package.js';

// Run with: npm run seed   (loads DATABASE_URL from .env via node --env-file)
const connectionString = process.env['DATABASE_URL'];
if (!connectionString) {
  throw new Error('DATABASE_URL is not set');
}

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
try {
  await seedPackage(prisma);
  console.log('Seed complete: launch package present.');
} finally {
  await prisma.$disconnect();
}
