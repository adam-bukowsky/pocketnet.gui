ImageUploader = function(app) {

    var self = this;

    // Upload an image to the right server
    // Type can be: "ipfs", "peertube", "imgur" or "up1"

    self.ipfsUploadBase64 = function(base64, filename) {
        var proxy = app.apireq;
        if (!proxy && app.platform && app.platform.apiproxy) {
            proxy = 'https://' + app.platform.apiproxy.host + ':' + app.platform.apiproxy.port;
        }
        if (!proxy) {
            proxy = window.location.protocol + '//' + window.location.host;
        }

        return new Promise(function(resolve, reject) {
            var xhr = new XMLHttpRequest();
            xhr.open('POST', proxy + '/ipfs/upload-base64', true);
            xhr.setRequestHeader('Content-Type', 'application/json');

            xhr.onload = function() {
                if (xhr.status === 200) {
                    try {
                        var body = JSON.parse(xhr.responseText);
                        var cid = body.data && body.data.cid;
                        if (!cid) {
                            reject({ text: 'IPFS upload no CID', code: 500 });
                            return;
                        }
                        var gateway = (app.ipfsGateway || 'https://ipfs.io/ipfs/') + cid;
                        resolve(gateway);
                    } catch (e) {
                        reject({ text: 'IPFS upload parse error', code: 500 });
                    }
                } else {
                    reject({ text: 'IPFS upload failed', code: xhr.status });
                }
            };

            xhr.onerror = function() {
                reject({ text: 'IPFS upload network error', code: 0 });
            };

            xhr.send(JSON.stringify({ base64: base64, filename: filename || 'image.png' }));
        });
    };

    self.upload = function({base64, type}){

        if (base64.indexOf('data:image') > -1){

            return self.ipfsUploadBase64(base64).catch(function(err) {
                console.error(err);
                return self.uploadImage({ base64 }, 'up1');
            }).catch(function(err) {
                console.error(err);
                return self.uploadImage({ base64 }, 'imgur');
            }).catch(function(err) {
                console.error(err);
                return self.uploadImage({ base64 }, 'peertube');
            }).then(function(url) {
                return Promise.resolve(url);
            }).catch(function(err) {
                console.error(err);
                return Promise.reject(err);
            });

        }
        else{
            return Promise.resolve(base64)
        }

    }

    self.uploadImage = function({base64, type}, system) {

        return new Promise(function(resolve, reject) {

            var p = {
                type : "POST",
                data : {},
                success : resolve,
                fail : reject
            };

            switch(system) {
                case 'imgur':
                    p.imgur = true;
                    p.data.Action = "image";
                    p.data.image = base64.split(',')[1];
                    break;

                case 'up1':
                    p.up1 = true;
                    p.data.file = base64.split(',')[1];
                    break;

                default:
                    p.peertubeImage = true;
                    p.data.base64 = base64;
                    p.data.Action = "upload";
            }

            if (p.peertubeImage){
                app.peertubeHandler.api.proxy.bestIfNeed().finally(function() {

                    if(!app.options.peertubeServer){
                        reject('peertubeServer')
                        return
                    }

                    var server = app.peertubeHandler.helpers.urlextended(app.options.peertubeServer, true)

                    p.url = server.current
                    if (p.url[p.url.length - 1] != '/')
                        p.url += '/';
                    p.url += 'api/v1/';

                    p.success = function(data){

                        app.Logger.info({ actionId: "IMG_PEERTUBE_UPLOAD_SUCCESS" });

                        var url = data.url.indexOf('http://') > -1 ? data.url : 'https://' + data.url

                        resolve(url)
                    }

                    p.fail = function(e){

                        app.Logger.info({ actionId: "IMG_PEERTUBE_UPLOAD_FAILED" });

                        reject(e)
                    }

                    app.ajax.run(p)

                }).catch(function(e) {
                    reject(e)
                });

                return
            }

            if (p.up1){
                p.success = function(data){

                    var url = 'https://bastyon.com:8092/i/' + deep(data, 'data.ident')

                    resolve(url)
                }

                p.fail = function(e){

                    app.Logger.info({ actionId: "IMG_UP1_UPLOAD_FAILED" });

                    reject(e)
                }
            }

            if (p.imgur){
                p.success = function(data){

                    app.Logger.info({ actionId: "IMG_IMGUR_UPLOAD_SUCCESS" });

                    var url =  deep(data, 'data.link')
                    resolve(url)
                }

                p.fail = function(e){

                    app.Logger.info({ actionId: "IMG_IMGUR_UPLOAD_FAILED" });

                    reject(e)
                }
            }

            app.ajax.run(p);
        });

    }

}

if(typeof module != "undefined")
{
	module.exports = ImageUploader;
}