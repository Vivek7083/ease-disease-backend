/**
 * The booking form's required fields, in a shape the database accepts. Spread into any `prisma.booking.create`
 * data in tests: `{ ...CONSULTEE, reference, userId, ... }`. These columns are NOT NULL, so every booking needs them.
 */
export const CONSULTEE = {
  consulteeName: 'Priya Sharma',
  consulteeWhatsappNumber: '+919876543210',
  consulteeEmail: 'priya@example.com',
  consulteeAge: 34,
  consulteeCity: 'Bengaluru',
} as const;
