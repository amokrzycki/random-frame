//! Limited preview decoder. Pixel caps and serialization also bound best-effort codec limits.
use crate::error::{AppError, ErrorKind};
use image::{
    codecs::jpeg::JpegEncoder, DynamicImage, ImageDecoder, ImageReader, Limits, Rgb, RgbImage,
};
use std::io::Cursor;

pub(super) fn encode(bytes: &[u8]) -> Result<Vec<u8>, AppError> {
    let failure = |e: String| {
        AppError::new(
            ErrorKind::InvalidResponse,
            format!("Preview unavailable: {e}"),
        )
    };
    let mut reader = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|e| failure(e.to_string()))?;
    if !matches!(
        reader.format(),
        Some(
            image::ImageFormat::Jpeg
                | image::ImageFormat::Png
                | image::ImageFormat::WebP
                | image::ImageFormat::Gif
        )
    ) {
        return Err(failure("unsupported image format".into()));
    }
    let mut limits = Limits::default();
    limits.max_image_width = Some(8192);
    limits.max_image_height = Some(8192);
    limits.max_alloc = Some(32 * 1024 * 1024);
    reader.limits(limits);
    let mut decoder = reader.into_decoder().map_err(|e| failure(e.to_string()))?;
    let (width, height) = decoder.dimensions();
    if width == 0 || height == 0 || u64::from(width) * u64::from(height) > 4_194_304 {
        return Err(failure("image exceeds preview pixel limit".into()));
    }
    let orientation = decoder.orientation().map_err(|e| failure(e.to_string()))?;
    let mut image = DynamicImage::from_decoder(decoder).map_err(|e| failure(e.to_string()))?;
    image.apply_orientation(orientation);
    let image = if image.width() > 768 || image.height() > 768 {
        image.thumbnail(768, 768)
    } else {
        image
    }
    .to_rgba8();
    let mut backing = RgbImage::from_pixel(image.width(), image.height(), Rgb([34, 35, 31]));
    for (x, y, pixel) in image.enumerate_pixels() {
        let alpha = u32::from(pixel[3]);
        let background = backing.get_pixel_mut(x, y);
        for c in 0..3 {
            background[c] = u8::try_from(
                (u32::from(pixel[c]) * alpha + u32::from(background[c]) * (255 - alpha) + 127)
                    / 255,
            )
            .map_err(|e| failure(e.to_string()))?;
        }
    }
    let mut jpeg = Vec::new();
    JpegEncoder::new_with_quality(&mut jpeg, 70)
        .encode_image(&backing)
        .map_err(|e| failure(e.to_string()))?;
    if jpeg.len() > 128 * 1024 {
        // Keep complex previews within the existing per-file and cache budgets.
        jpeg.clear();
        JpegEncoder::new_with_quality(&mut jpeg, 70)
            .encode_image(&DynamicImage::ImageRgb8(backing).thumbnail(384, 384))
            .map_err(|e| failure(e.to_string()))?;
    }
    if jpeg.len() > 128 * 1024 {
        return Err(failure("encoded preview exceeds byte limit".into()));
    }
    Ok(jpeg)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn contains_without_upscaling_and_backs_alpha() -> Result<(), Box<dyn std::error::Error>> {
        let image = DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(
            1200,
            600,
            image::Rgba([255, 0, 0, 0]),
        ));
        let mut png = Cursor::new(Vec::new());
        image.write_to(&mut png, image::ImageFormat::Png)?;
        let jpeg = encode(png.get_ref())?;
        let decoded = image::load_from_memory(&jpeg)?.to_rgb8();
        assert_eq!(decoded.dimensions(), (768, 384));
        assert!(decoded.get_pixel(0, 0)[0].abs_diff(34) < 4);
        assert!(encode(b"not an image").is_err());
        Ok(())
    }
}

#[cfg(test)]
mod codec_tests {
    use super::*;
    #[test]
    fn limited_codecs_keep_small_images_small_and_reject_resource_limits(
    ) -> Result<(), Box<dyn std::error::Error>> {
        for format in [
            image::ImageFormat::Jpeg,
            image::ImageFormat::Png,
            image::ImageFormat::WebP,
            image::ImageFormat::Gif,
        ] {
            let original = DynamicImage::new_rgb8(16, 8);
            let mut encoded = Cursor::new(Vec::new());
            original.write_to(&mut encoded, format)?;
            let preview = image::load_from_memory(&encode(encoded.get_ref())?)?;
            assert_eq!((preview.width(), preview.height()), (16, 8));
        }
        let mut seed = 1_u32;
        let noise = RgbImage::from_fn(1200, 800, |_, _| {
            let mut pixel = [0; 3];
            for channel in &mut pixel {
                seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                *channel = seed.to_le_bytes()[3];
            }
            Rgb(pixel)
        });
        let mut noisy = Cursor::new(Vec::new());
        DynamicImage::ImageRgb8(noise).write_to(&mut noisy, image::ImageFormat::Png)?;
        let preview = encode(noisy.get_ref())?;
        assert!(preview.len() <= 128 * 1024);
        let decoded = image::load_from_memory(&preview)?;
        assert!(decoded.width() <= 768 && decoded.height() <= 768);
        let mut wide = Cursor::new(Vec::new());
        DynamicImage::new_rgb8(8193, 1).write_to(&mut wide, image::ImageFormat::Png)?;
        assert!(encode(wide.get_ref()).is_err());
        let mut pixels = Cursor::new(Vec::new());
        DynamicImage::new_rgb8(2049, 2048).write_to(&mut pixels, image::ImageFormat::Png)?;
        assert!(encode(pixels.get_ref()).is_err());
        let mut jpeg = Vec::new();
        JpegEncoder::new_with_quality(&mut jpeg, 70).encode_image(&DynamicImage::new_rgb8(3, 2))?;
        let exif = [
            b'E', b'x', b'i', b'f', 0, 0, b'I', b'I', 42, 0, 8, 0, 0, 0, 1, 0, 0x12, 1, 3, 0, 1, 0,
            0, 0, 6, 0, 0, 0, 0, 0, 0, 0,
        ];
        let mut oriented = vec![0xff, 0xd8, 0xff, 0xe1, 0, 34];
        oriented.extend_from_slice(&exif);
        oriented.extend_from_slice(&jpeg[2..]);
        let preview = image::load_from_memory(&encode(&oriented)?)?;
        assert_eq!((preview.width(), preview.height()), (2, 3));
        let mut gif = Vec::new();
        {
            let mut writer = image::codecs::gif::GifEncoder::new(&mut gif);
            for color in [image::Rgba([255, 0, 0, 255]), image::Rgba([0, 0, 255, 255])] {
                writer
                    .encode_frame(image::Frame::new(image::RgbaImage::from_pixel(2, 2, color)))?;
            }
        }
        let first = image::load_from_memory(&encode(&gif)?)?.to_rgb8();
        assert!(first.get_pixel(0, 0)[0] > first.get_pixel(0, 0)[2]);
        Ok(())
    }
}
