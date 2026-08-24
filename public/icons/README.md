This directory holds PWA icons for CargoExpress PH.

All icons use the same artwork as `public/logo.png`; the source is resized
locally for each platform size so the brand stays consistent without sending
the 2000px master image to small UI surfaces.

Required icon files:
- icon-32.png    (32x32)
- icon-72.png    (72x72)
- icon-96.png    (96x96)
- icon-128.png   (128x128)
- icon-144.png   (144x144)
- icon-152.png   (152x152)
- icon-180.png   (180x180)
- icon-192.png   (192x192)
- icon-384.png   (384x384)
- icon-512.png   (512x512)
- icon-maskable-192.png  (192x192, with safe zone padding)
- icon-maskable-512.png  (512x512, with safe zone padding)

The checked-in files are generated from `public/logo.png`. Keep the regular
icons at the listed dimensions and keep the maskable icons padded inside the
safe zone.
