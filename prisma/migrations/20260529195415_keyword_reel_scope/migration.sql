-- DropIndex
DROP INDEX "keywords_keyword_key";

-- AlterTable
ALTER TABLE "keywords" ADD COLUMN     "media_caption" TEXT,
ADD COLUMN     "media_id" TEXT,
ADD COLUMN     "media_permalink" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "keywords_keyword_media_id_key" ON "keywords"("keyword", "media_id");

