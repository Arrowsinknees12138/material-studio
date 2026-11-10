INSERT INTO users (username, display_name, password_hash) VALUES
  ('lin', '林夏', '$2b$12$Zn7O0z6Ip6GVBXvGs60PeOH79S/2OCUhflspiK9NgEdTNPxncysx2'),
  ('zhou', '周野', '$2b$12$Zn7O0z6Ip6GVBXvGs60PeOH79S/2OCUhflspiK9NgEdTNPxncysx2');

INSERT INTO templates
  (id, title, category, description, cover_url, sample_result, required_image_count, accepted_mime_types, max_file_size_bytes, sort_order)
VALUES
  ('coast', '海岸明信片', '旅行风景', '把两张旅途照片放进一张海岸明信片，留住海风和落日。', '/demo/coast.jpg', 'coast-result.jpg', 2, 'image/jpeg,image/png', 5242880, 10),
  ('desert', '沙丘日记', '旅行风景', '用一张照片制作暖色沙漠风格的旅行纪念图。', '/demo/desert.jpg', 'desert-result.jpg', 1, 'image/jpeg,image/png', 5242880, 20),
  ('moon', '月面来信', '创意合成', '用一张照片制作冷色调的太空杂志封面。', '/demo/moon.jpg', 'moon-result.jpg', 1, 'image/jpeg,image/png', 5242880, 30),
  ('garden', '静物花园', '生活手账', '选一张生活照片，给它一张安静的植物插画背景。', '/demo/garden.jpg', 'garden-result.jpg', 1, 'image/jpeg,image/png', 5242880, 40),
  ('city', '蓝调城市', '创意合成', '上传两张照片，模拟制作一幅夜行城市双图海报。', '/demo/city.jpg', 'city-result.jpg', 2, 'image/jpeg,image/png', 5242880, 50),
  ('morning', '晨间放映', '生活手账', '让一张日常照片成为一帧带暖光的晨间画面。', '/demo/morning.jpg', 'morning-result.jpg', 1, 'image/jpeg,image/png', 5242880, 60);
