var extend = require('extend'),
    earcut = require('earcut'),
    getNormals = require('polyline-normals'),
    async = require('async'),
    three = require('three'),
    proj4 = require('proj4'),
    coordEach = require('turf-meta').coordEach,
    reproject = require('reproject').reproject,
    vnIndex = 0,
    polygonFaces = function(vertices, baseIndex) {
        var list= [];
        vertices.map(function(v, i){
            list.push([(i * 2) + baseIndex, (i * 2) + 2 + baseIndex, (i * 2) + 3 + baseIndex]);
            list.push([(i * 2) + baseIndex, (i * 2) + 3 + baseIndex, (i * 2) + 1 + baseIndex]);
        });
        return list;
    },
    polygonTopSurface = function(vertices, baseIndex) {
        return [vertices.map(function(v, i) {
            return (i * 2 + 1) + baseIndex;
        })];
    },
    sumVectors = function(list, suface){
        var vec = [0,0,0];
        list.forEach(function(e){
            var v = suface[e];
            vec[0] += v[0];
            vec[1] += v[1];
            vec[2] += v[2];
        });
        return vec;
    },
    transforms = {
        'LineString': function(f, reprojectedGeometry, options, cb) {
            options.lineWidth(f, function(err, width) {
                if (err) {
                    cb(err);
                    return;
                }

                var normals = getNormals(reprojectedGeometry.coordinates),
                    coords = new Array(reprojectedGeometry.coordinates.length * 2),
                    transformed = {
                        type: 'Polygon',
                        coordinates: [coords]
                    };
                
                reprojectedGeometry.coordinates.forEach(function(c, i) {
                    var halfWidth = normals[i][1] * width / 2,
                        dx = normals[i][0][0] * halfWidth,
                        dy = normals[i][0][1] * halfWidth;

                    coords[i] = [c[0] + dx, c[1] + dy, c[2]];
                    coords[reprojectedGeometry.coordinates.length * 2 - i - 1] = [c[0] - dx, c[1] - dy, c[2]];
                });
                coords.push(coords[0]);
                cb(undefined, transformed);
            });
        }
    },
    verticesFunc = {
        'Polygon': function(coordinates) {
            // Flatten
            return [].concat.apply([], coordinates);
        }
    },
    surfacesFunc = {
        'Polygon': function(coordinates, vertices, baseIndex, height) {
            var vs = vertices.slice(0, vertices.length - 1),
                faces = polygonFaces(vs, baseIndex);

            if (coordinates.length === 1) {
                var polygonTop = polygonTopSurface(vs, baseIndex);
                var vec = [];
                var rs = [];
                if(polygonTop.length == 1){
                    var map = {};
                    vertices.forEach(function (e) {
                        vec.push([e[0], e[1], e[2]]);
                        vec.push([e[0], e[1], e[2] + height]);
                    });
                    var i = 0;
                    polygonTop[0].forEach(function (e) {
                        map[i++] = e;
                        var v = vec[e - baseIndex];
                        rs.push(v[0]);
                        rs.push(v[1]);
                        rs.push(v[2]);
                    });
                    var triIndices = earcut(rs, null, 3);
                    for(var i = 0; i < triIndices.length; i = i + 3){
                        faces.push([map[triIndices[i]],map[triIndices[i+1]],map[triIndices[i+2]]]);
                    }
                }
            } else {
                // Triangulate top surface
                var flatPolyCoords = [].concat.apply([], vs),
                    holeIndices = coordinates.slice(2).reduce(function(holeIndices, ring, i) {
                        var prevHoleIndex = holeIndices[holeIndices.length - 1];
                        holeIndices.push(prevHoleIndex + coordinates[i + 1].length * 2);
                        return holeIndices;
                    }, [coordinates[0].length * 2]);
                var triIndices = earcut(flatPolyCoords, holeIndices);
                [].concat.apply(faces, triIndices);
            }

            return faces;
        }
    },
    normalsFunc = {
        'Polygon': function(surfaces, vertices, height, nIndices) {
            //console.log(three);
            var geometry = new three.Geometry();
            geometry.vertices = [];
            geometry.faces = [];
            vertices.forEach(function (v) {
                geometry.vertices.push(new three.Vector3(v[1], v[2], v[0]));
                geometry.vertices.push(new three.Vector3(v[1],  v[2] + height, v[0]));
            });
            surfaces.forEach(function (e) {
                geometry.faces.push(new three.Face3((e[0] - nIndices), (e[1] - nIndices), (e[2] - nIndices)));
            });
            //geometry.computeFaceNormals();
            geometry.computeVertexNormals();
            return geometry;
        }
    };

module.exports = function featureToGeoJson(f, stream, nIndices, options, cb) {
    if (f.geometry.type === 'MultiPolygon') {
        async.reduce(f.geometry.coordinates, nIndices, function(nIndices, polygonCoords, cb) {
            var feature = extend({}, f, {
                geometry: {
                    type: 'Polygon',
                    coordinates: polygonCoords
                }
            });

            featureToGeoJson(feature, stream, nIndices, options, function(err, producedVertices) {
                if (err) {
                    cb(err);
                    return;
                }

                cb(undefined, nIndices + producedVertices);
            });
        }, function(err, totalVertices) {
            if (err) {
                cb(err);
                return;
            }

            cb(undefined, totalVertices - nIndices);
        });
        return;
    }

    var reprojectedGeometry = reproject(f.geometry, proj4.WGS84, options.projection),
        transformFunc = transforms[f.geometry.type] || function(f, reprojectedGeometry, options, cb) {
            cb(undefined, reprojectedGeometry);
        };

    transformFunc(f, reprojectedGeometry, options, function(err, geom) {
        if (err) {
            cb(err);
            return;
        }

        async.parallel([
            geom.coordinates[0][0][2] ? function(cb) { cb(); } : function(cb) {
                options.featureBase(f, function(err, base) {
                    if (err) {
                        cb(err);
                        return;
                    }

                    coordEach(geom, function(c) { c[2] = base; });
                    cb(undefined, base);
                });
            },
            function(cb) { options.featureHeight(f, cb); },
            function(cb) { options.featureMaterial(f, cb); },
            function(cb) { options.featureName(f, cb); }
        ], function(err, data) {
            if (err) {
                cb(err);
                return;
            }

            var height = data[1],
                materialName = data[2],
                vFunc = verticesFunc[geom.type],
                sFunc = surfacesFunc[geom.type],
                vnFunc = normalsFunc[geom.type],
                vertices,
                surfaces,
                vnormals,
                name = data[3];
            if(f.properties.BuildingHe != null){
                height = f.properties.BuildingHe;
            }
            if (!vFunc) {
                throw 'No verticesFunc for geometry type ' + geom.type;
            }
            if (!sFunc) {
                throw 'No surfacesFunc for geometry type ' + geom.type;
            }
            if (!vnFunc) {
                throw 'No normalsFunc for geometry type ' + geom.type;
            }
            vertices = vFunc(geom.coordinates);
            surfaces = sFunc(geom.coordinates, vertices, nIndices, height);
            vnormals = vnFunc(surfaces, vertices, height, nIndices);

            if (name) {
                stream.write('g ' + name + '\n');
            }

            if (materialName) {
                stream.write('usemtl ' + materialName + '\n');
            }

            vertices.forEach(function(v) {
                stream.write('v ' + v[1] + ' ' + v[2] + ' ' + v[0] + '\n');
                stream.write('v ' + v[1] + ' ' + (v[2] + height) + ' ' + v[0] + '\n');
            });

            var hash = {};
            var i = 0;
            vnormals.faces.forEach(function(e){
                var f0 = e.vertexNormals[0];
                var f1 = e.vertexNormals[1];
                var f2 = e.vertexNormals[2];
                var k0 = "vn " + f0.x + " " + f0.y + " " + f0.z;
                var k1 = "vn " + f1.x + " " + f1.y + " " + f1.z;
                var k2 = "vn " + f2.x + " " + f2.y + " " + f2.z;
                if(hash[k0] == null){
                    hash[k0] = i;
                    i++;
                }
                if(hash[k1] == null){
                    hash[k1] = i;
                    i++;
                }
                if(hash[k2] == null){
                    hash[k2] = i;
                    i++;
                }
            });
            if(vnIndex == 0){
                vnIndex = nIndices;
            }
            var i = vnIndex;
            for(var k in hash){
                stream.write(k + '\n');
                vnIndex++;
            }
            vnormals.faces.forEach(function(e){
                var f0 = e.vertexNormals[0];
                var f1 = e.vertexNormals[1];
                var f2 = e.vertexNormals[2];
                var k0 = "vn " + f0.x + " " + f0.y + " " + f0.z;
                var k1 = "vn " + f1.x + " " + f1.y + " " + f1.z;
                var k2 = "vn " + f2.x + " " + f2.y + " " + f2.z;
                //stream.write('f ' + (e.a + nIndices) + " " + (e.b + nIndices) + " " + (e.c + nIndices) + '\n');
                stream.write('f ' + (e.a + nIndices)  + "//" + (hash[k0] + i) + " " + (e.b + nIndices) + "//" + (hash[k1] + i) + " " + (e.c + nIndices) + "//" + (hash[k2] + i) + '\n');
            })
            /*
            surfaces.forEach(function(s) {
                stream.write('f ' + s.join(' ') + '\n');
            });*/
            stream.write('\n');

            cb(undefined, vertices.length * 2);
        });
    });
};
