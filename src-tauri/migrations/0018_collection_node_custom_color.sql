ALTER TABLE collection_nodes ADD COLUMN custom_color TEXT
    CHECK (
        length(custom_color) = 7
        AND substr(custom_color, 1, 1) = '#'
        AND substr(custom_color, 2) NOT GLOB '*[^0-9A-Fa-f]*'
    );
