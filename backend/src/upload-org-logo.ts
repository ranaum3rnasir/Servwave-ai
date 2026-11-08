import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { createClient } from '@supabase/supabase-js';
import { PrismaClient } from '@prisma/client';

dotenv.config();

const ALPHA_ORG_ID = '00000000-0000-0000-0000-000000000001';
const BUCKET = 'org-assets';
// Repo-relative so this runs on any OS. __dirname = backend/src; ../../ = repo root.
const LOGO_PATH = path.resolve(__dirname, '../../examples/alpha-logo/alpha-logo-cropped (1).jpg');
const STORAGE_KEY = `${ALPHA_ORG_ID}/logo.jpg`;

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const prisma = new PrismaClient();

async function main() {
  // Ensure bucket exists
  const { data: buckets } = await supabase.storage.listBuckets();
  const exists = buckets?.some(b => b.name === BUCKET);
  if (!exists) {
    const { error } = await supabase.storage.createBucket(BUCKET, { public: true });
    if (error) throw new Error(`Failed to create bucket: ${error.message}`);
    console.log(`Created bucket: ${BUCKET}`);
  }

  // Upload logo
  const fileBuffer = fs.readFileSync(LOGO_PATH);
  const { error: uploadError } = await supabase.storage
    .from(BUCKET)
    .upload(STORAGE_KEY, fileBuffer, {
      contentType: 'image/jpeg',
      upsert: true,
    });
  if (uploadError) throw new Error(`Upload failed: ${uploadError.message}`);

  // Get public URL
  const { data: { publicUrl } } = supabase.storage.from(BUCKET).getPublicUrl(STORAGE_KEY);
  console.log('Public URL:', publicUrl);

  // Update org record
  await prisma.organization.update({
    where: { id: ALPHA_ORG_ID },
    data: { logo_url: publicUrl },
  });
  console.log('Organization logo_url updated.');
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
