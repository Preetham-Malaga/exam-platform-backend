// PURPOSE: Validation for the extra student and teacher fields stored in each person's "details" (migration 047).
// WHY: The prototype forms ask for date of birth, education background, address, guardian and professional details.
//      Every field is optional and checked here, so only known keys with sensible values reach the database.
// DEPENDS ON: zod.

import { z } from 'zod';

const text = (max: number) => z.string().trim().max(max);
const date = z.iso.date();
const phone = z
  .string()
  .trim()
  .regex(/^(\+?91)?[6-9]\d{9}$/, 'Enter a 10-digit mobile number starting with 6, 7, 8 or 9.');
const year = z.number().int().min(1950).max(2100);
const common = {
  gender: z.enum(['Female', 'Male', 'Other', 'Prefer not to say']),
  dateOfBirth: date,
  altMobile: phone,
  address: text(300),
  city: text(100),
  state: text(100),
  pinCode: z.string().regex(/^\d{6}$/, 'Enter a 6-digit PIN code.'),
};

export const studentDetailsSchema = z
  .object({
    ...common,
    admissionNumber: text(30),
    admissionDate: date,
    previousInstitution: text(150),
    board: text(100),
    previousCourse: text(100),
    yearOfPassing: year,
    previousResult: z.number().min(0).max(100),
    guardianName: text(100),
    guardianRelation: z.enum(['Father', 'Mother', 'Guardian', 'Other']),
    guardianMobile: phone,
    guardianEmail: z.string().trim().email().max(254),
    guardianOccupation: text(100),
    updatesVia: z.array(z.enum(['WhatsApp', 'SMS', 'Email'])).max(3),
  })
  .partial()
  .strict();

export const teacherDetailsSchema = z
  .object({
    ...common,
    designation: z.enum([
      'Professor',
      'Associate Professor',
      'Assistant Professor',
      'Lecturer',
      'Faculty',
      'Guest faculty',
    ]),
    department: text(100),
    qualification: text(100),
    specialization: text(100),
    university: text(150),
    yearOfPassing: year,
    experienceYears: z.number().min(0).max(60),
    joiningDate: date,
    employmentType: z.enum(['Full-time', 'Part-time', 'Visiting']),
  })
  .partial()
  .strict();
