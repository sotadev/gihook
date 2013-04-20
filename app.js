//Dependencies
var http = require("http");
var fs = require("fs");
var path = require("path");
var child_process = require('child_process');
var log = require("./logging");
//Runtime variables
var cfg_dir = __dirname + '/config/';
var cfg_map = {};

//Format function, move somewhere
String.prototype.fmt = function(hash) {
    var s = this.toString();
    if(typeof hash == 'object') {
        for(var k in hash){
            s = s.split('{' + k + '}').join(hash[k]);
        }
    }
    return s;
};

var processFile = function(fileName){
    var filePath = cfg_dir + fileName;
    var fileExt = path.extname(fileName);
    if(fileExt != '.json'){
        return log('Problem with file "' + filePath + '". There must be .json file extension.', 'runtime');
    }
    
    fs.readFile(filePath, 'utf-8', function(err, data) {
        var cfg = {};
        try{
            if(err) throw err;
            
            cfg = JSON.parse(data);
            if([cfg.path, cfg.user, cfg.commands].indexOf(undefined) !== -1){
                throw new Error('Bad config file "' + filePath + '". It need to be json object with path, user and commands keys.');
            }
        } catch(e) {
            return log('Error while processing file "' + filePath + '": ' + e, 'runtime');
        }
        //Populate good cfg object to objects map by filename without extension
        return cfg_map[path.basename(fileName, fileExt)] = cfg;
    });
};

// Readfiles to object on server start
fs.readdir(cfg_dir, function(wtf, files){
    var watchCallback = function(prev, next) {
        processFile(files[i]);
    };
    
    for(var i in files){
        try{
            processFile(files[i]);
            fs.watchFile(cfg_dir + files[i], watchCallback);
        } catch(e) {
            log(e, 'startup');
        }
    }
    
    //Watch for changes
    fs.watch(cfg_dir, function(event, fileName) {
        processFile(fileName);
    });
});

//Server options
if(process.argv[2]){
    var run_argv = process.argv[2].split(':');
    process.env.IP = run_argv[0] || '0.0.0.0';
    process.env.PORT = run_argv[1];
}
process.env.IP = process.env.IP || '0.0.0.0';
process.env.PORT = process.env.PORT || 8001;

//Create Server
http.createServer(function(request, response) {
    request.url = request.url.slice(1);
    
    //Prevent favicon.ico requests
    if(request.url == 'favicon.ico') return request.connection.destroy();
    
    if(request.method == 'POST' && cfg_map[request.url]){
        var body = '';
        request.on('data', function (data) {
            body += data;
            if (body.length > 1e6) {
                // FLOOD ATTACK OR FAULTY CLIENT, NUKE REQUEST
                request.connection.destroy();
            }
        });
        
        request.on('end', function () {
            try{
                var bodyObj = JSON.parse(body);
            } catch(e) {
                return log('Malformed json. Request body: ' + body, request.url + '.error');
            }
            
            var cfg = cfg_map[request.url];
            var spawn_options = {
                encoding: "utf-8",
                env: process.env
            };
            
            if(cfg.user) {
                spawn_options.uid = cfg.user;
            }
            
            if(!fs.readdirSync(cfg.path)) {
                return log('Invalid path "' + cfg.path + '" in config "' + request.url + '"', request.url + '.error');
            }
            spawn_options.cwd = cfg.path;
            
            Object.keys(cfg.refs).some(function (k) {
                    return bodyObj.ref.match(cfg.refs[k]);
                });
            
            if(cfg.refs){
                var refsType = typeof cfg.refs;
                if(['string', 'object'].indexOf(refsType)){
                    if(refsType == 'string') cfg.refs = [cfg.refs];
                    
                    var suitableRef = Object.keys(cfg.refs).some(function (k) {
                        return bodyObj.ref.match(cfg.refs[k]);
                    });
                    if(!suitableRef) return log('Ref does not fit. Aborting.', request.url + '.info');
                }
            }
            
            if(cfg.commands.length){
                var executed = [];
                
                var processCommand = function(cmd) {
                    var commandString = cmd.join(' ');
                    var result = child_process.spawn(cmd.shift(), cmd, spawn_options);
                    
                    result.stdout.on('data', resultCallback(commandString, 'Data from "{command}": {data}', request.url + '.info'));
                    result.stderr.on('data', resultCallback(commandString, 'Error in "{command}": {data}', request.url + '.error'));
                };
                
                var resultCallback = function(cmd_string, format, file) {
                    return function(data) {
                        executed.push(cmd_string);
                        
                        log(format.fmt({
                            command: cmd_string,
                            data: data
                        }));
                        
                        var next = cfg.commands.shift();
                        if(next && executed.indexOf(next.join(' ')) == -1) {
                            processCommand(next);
                        }
                    };
                };
                
                processCommand(cfg.commands.shift());
            } else {
                return log('No commands to execute.', request.url + '.info');
            }
        });
        
        response.end("Process in queue!");
    } else {
        response.writeHead(200);
        response.end("There is something, you don't need know.");
    }
}).listen(process.env.PORT, process.env.IP);
