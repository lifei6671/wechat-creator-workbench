use crate::db::{AppError, Result};
use chrono::{DateTime, Utc};
use image::{
    DynamicImage, ImageDecoder, ImageFormat, ImageReader, codecs::webp::WebPDecoder,
    imageops::FilterType,
};
use serde::{Deserialize, Serialize};
use std::io::Cursor;

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct UploadOptions {
    pub filename_template: String,
    pub quality: Quality,
}

#[derive(Clone, Copy, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Quality {
    #[default]
    Original,
    High,
    Standard,
    Economy,
}

impl UploadOptions {
    pub fn filename(&self, name: &str, millis: i64) -> Result<String> {
        let template = self.filename_template.trim();
        if template.is_empty() {
            return Ok(name.to_owned());
        }
        let time = DateTime::<Utc>::from_timestamp_millis(millis)
            .expect("system timestamp is representable");
        let mut stem = template.replace("{timestamp}", &millis.to_string());
        for (key, pattern) in [
            ("{year}", "%Y"),
            ("{month}", "%m"),
            ("{day}", "%d"),
            ("{hour}", "%H"),
            ("{minute}", "%M"),
            ("{second}", "%S"),
        ] {
            stem = stem.replace(key, &time.format(pattern).to_string());
        }
        if !valid_stem(&stem) {
            return Err(AppError::invalid(
                "文件名规则仅支持日期和时间占位符、字母、数字、下划线和连字符，展开后最多 96 字符",
            ));
        }
        Ok(format!("{stem}-{name}"))
    }

    pub fn encode(&self, bytes: Vec<u8>) -> Result<(ImageFormat, Vec<u8>)> {
        let error =
            |err: image::ImageError| AppError::new("IMAGE_FORMAT", format!("无法压缩图片：{err}"));
        let (format, ..) = super::image_header(&bytes)?;
        let (scale, quality) = match self.quality {
            Quality::Original => return Ok((format, bytes)),
            Quality::High => (85, 90.0),
            Quality::Standard => (65, 75.0),
            Quality::Economy => (45, 55.0),
        };
        if format == ImageFormat::Gif
            || (format == ImageFormat::WebP
                && WebPDecoder::new(Cursor::new(&bytes))
                    .map_err(error)?
                    .has_animation())
        {
            return Ok((format, bytes));
        }
        let mut decoder = ImageReader::with_format(Cursor::new(&bytes), format)
            .into_decoder()
            .map_err(error)?;
        let orientation = decoder.orientation().map_err(error)?;
        let mut image = DynamicImage::from_decoder(decoder).map_err(error)?;
        image.apply_orientation(orientation);
        let scaled = image.resize(
            (image.width() * scale / 100).max(1),
            (image.height() * scale / 100).max(1),
            FilterType::Lanczos3,
        );
        let (width, height) = (scaled.width(), scaled.height());
        let encoded = if scaled.color().has_alpha() {
            webp::Encoder::from_rgba(&scaled.into_rgba8(), width, height)
                .encode_simple(false, quality)
        } else {
            webp::Encoder::from_rgb(&scaled.into_rgb8(), width, height)
                .encode_simple(false, quality)
        }
        .map_err(|err| AppError::new("IMAGE_FORMAT", format!("无法编码 WebP 图片：{err:?}")))?;
        if encoded.len() > super::MAX_BYTES {
            return Err(AppError::new(
                "IMAGE_SIZE",
                "转换后的 WebP 超过 20 MB，请选择更低的清晰度",
            ));
        }
        Ok((ImageFormat::WebP, encoded.to_vec()))
    }
}

fn valid_stem(stem: &str) -> bool {
    !stem.is_empty()
        && stem.chars().count() <= 96
        && stem
            .chars()
            .all(|ch| ch.is_alphanumeric() || matches!(ch, '-' | '_'))
}

pub(crate) fn original_name(name: &str, hash: &str) -> bool {
    let Some((stem, extension)) = name.rsplit_once('.') else {
        return false;
    };
    hash.len() == 64
        && hash
            .bytes()
            .all(|ch| ch.is_ascii_digit() || (b'a'..=b'f').contains(&ch))
        && matches!(extension, "png" | "jpg" | "jpeg" | "gif" | "webp")
        && (stem == hash
            || stem
                .strip_suffix(hash)
                .and_then(|prefix| prefix.strip_suffix('-'))
                .is_some_and(valid_stem))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expands_utc_variables_and_keeps_object_names_distinct() {
        let hash = "0123456789abcdef".repeat(4);
        let name = format!("{hash}.jpg");
        let mut options = UploadOptions {
            filename_template: "图片-{year}{month}{day}-{hour}{minute}{second}-{timestamp}".into(),
            quality: Quality::Standard,
        };
        let expanded = options.filename(&name, 0).unwrap();
        assert_eq!(expanded, format!("图片-19700101-000000-0-{name}"));
        assert!(original_name(&expanded, &hash));
        assert!(original_name(&name, &hash));
        options.filename_template = "../{year}".into();
        assert!(options.filename(&name, 0).is_err());
    }

    #[test]
    fn static_images_use_webp_at_each_compressed_quality() {
        let transparent = DynamicImage::ImageRgba8(image::ImageBuffer::from_pixel(
            100,
            80,
            image::Rgba([0, 10, 80, 127]),
        ));
        for (source, alpha) in [
            (ImageFormat::Jpeg, false),
            (ImageFormat::Png, true),
            (ImageFormat::WebP, true),
        ] {
            let mut source_bytes = Cursor::new(Vec::new());
            let image = if alpha {
                transparent.clone()
            } else {
                DynamicImage::new_rgb8(100, 80)
            };
            image.write_to(&mut source_bytes, source).unwrap();
            let source_bytes = source_bytes.into_inner();
            assert_eq!(
                UploadOptions::default()
                    .encode(source_bytes.clone())
                    .unwrap(),
                (source, source_bytes.clone())
            );
            for (quality, width, height) in [
                (Quality::High, 85, 68),
                (Quality::Standard, 65, 52),
                (Quality::Economy, 45, 36),
            ] {
                let options = UploadOptions {
                    quality,
                    ..UploadOptions::default()
                };
                let (format, compressed) = options.encode(source_bytes.clone()).unwrap();
                assert_eq!(format, ImageFormat::WebP);
                assert_eq!(image::guess_format(&compressed).unwrap(), ImageFormat::WebP);
                let decoded = image::load_from_memory(&compressed).unwrap();
                assert_eq!((decoded.width(), decoded.height()), (width, height));
                if alpha {
                    assert_eq!(decoded.to_rgba8().get_pixel(0, 0).0[3], 127);
                }
            }
        }
    }

    #[test]
    fn compressed_modes_preserve_gif_and_animated_webp_bytes() {
        let mut gif = Cursor::new(Vec::new());
        DynamicImage::new_rgb8(4, 4)
            .write_to(&mut gif, ImageFormat::Gif)
            .unwrap();
        let config = webp::WebPConfig::new().unwrap();
        let mut animation = webp::AnimEncoder::new(4, 4, &config);
        animation.add_frame(webp::AnimFrame::from_rgb(&[0; 48], 4, 4, 0));
        animation.add_frame(webp::AnimFrame::from_rgb(&[255; 48], 4, 4, 100));
        let animated = animation.try_encode().unwrap().to_vec();
        assert!(
            WebPDecoder::new(Cursor::new(&animated))
                .unwrap()
                .has_animation()
        );
        let options = UploadOptions {
            quality: Quality::Economy,
            ..UploadOptions::default()
        };
        for (format, original) in [
            (ImageFormat::Gif, gif.into_inner()),
            (ImageFormat::WebP, animated),
        ] {
            assert_eq!(
                options.encode(original.clone()).unwrap(),
                (format, original)
            );
        }
    }
}
