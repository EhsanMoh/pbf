'use strict';

module.exports = Protobuf;

var Buffer = global.Buffer || require('./buffer');

function Protobuf(buf) {
    this.buf = !buf ? new Buffer(0) :
        !global.Buffer ? Buffer.wrap(buf) :
        buf instanceof Uint8Array ? new Buffer(buf) : buf;

    this.pos = 0;
    this.length = this.buf.length;
}

Protobuf.Varint  = 0; // varint: int32, int64, uint32, uint64, sint32, sint64, bool, enum
Protobuf.Fixed64 = 1; // 64-bit: double, fixed64, sfixed64
Protobuf.Bytes   = 2; // length-delimited: string, bytes, embedded messages, packed repeated fields
Protobuf.Fixed32 = 5; // 32-bit: float, fixed32, sfixed32

var SHIFT_LEFT_32 = (1 << 16) * (1 << 16),
    SHIFT_RIGHT_32 = 1 / SHIFT_LEFT_32;

Protobuf.prototype = {

    destroy: function() {
        this.buf = null;
    },

    // === READING =================================================================

    readFields: function(readField, result, end) {
        end = end || this.length;

        while (this.pos < end) {
            var val = this.readVarint(),
                tag = val >> 3,
                startPos = this.pos;
            readField(tag, result, this);
            if (this.pos === startPos) this.skip(val);
        }
        return result;
    },

    readMessage: function(readField, result) {
        var bytes = this.readVarint();
        return this.readFields(readField, result, this.pos + bytes);
    },

    readFixed32: function() {
        var val = this.buf.readUInt32LE(this.pos);
        this.pos += 4;
        return val;
    },

    readSFixed32: function() {
        var val = this.buf.readInt32LE(this.pos);
        this.pos += 4;
        return val;
    },

    // 64-bit int handling is based on github.com/dpw/node-buffer-more-ints (MIT-licensed)

    readFixed64: function() {
        var val = this.buf.readUInt32LE(this.pos) + this.buf.readUInt32LE(this.pos + 4) * SHIFT_LEFT_32;
        this.pos += 8;
        return val;
    },

    readSFixed64: function() {
        var val = this.buf.readUInt32LE(this.pos) + this.buf.readInt32LE(this.pos + 4) * SHIFT_LEFT_32;
        this.pos += 8;
        return val;
    },

    readFloat: function() {
        var val = this.buf.readFloatLE(this.pos);
        this.pos += 4;
        return val;
    },

    readDouble: function() {
        var val = this.buf.readDoubleLE(this.pos);
        this.pos += 8;
        return val;
    },

    readVarint: function() {
        var buf = this.buf,
            val, b, b0, b1, b2, b3;

        b0 = buf[this.pos++]; if (b0 < 0x80) return b0;                 b0 = b0 & 0x7f;
        b1 = buf[this.pos++]; if (b1 < 0x80) return b0 | b1 << 7;       b1 = (b1 & 0x7f) << 7;
        b2 = buf[this.pos++]; if (b2 < 0x80) return b0 | b1 | b2 << 14; b2 = (b2 & 0x7f) << 14;
        b3 = buf[this.pos++]; if (b3 < 0x80) return b0 | b1 | b2 | b3 << 21;

        val = b0 | b1 | b2 | (b3 & 0x7f) << 21;

        b = buf[this.pos++]; val += (b & 0x7f) * 0x10000000;         if (b < 0x80) return val;
        b = buf[this.pos++]; val += (b & 0x7f) * 0x800000000;        if (b < 0x80) return val;
        b = buf[this.pos++]; val += (b & 0x7f) * 0x40000000000;      if (b < 0x80) return val;
        b = buf[this.pos++]; val += (b & 0x7f) * 0x2000000000000;    if (b < 0x80) return val;
        b = buf[this.pos++]; val += (b & 0x7f) * 0x100000000000000;  if (b < 0x80) return val;
        b = buf[this.pos++]; val += (b & 0x7f) * 0x8000000000000000; if (b < 0x80) return val;

        throw new Error('Expected varint not more than 10 bytes');
    },

    readSVarint: function() {
        var num = this.readVarint();
        return num % 2 === 1 ? (num + 1) / -2 : num / 2; // zigzag encoding
    },

    readBoolean: function() {
        return Boolean(this.readVarint());
    },

    readString: function() {
        var bytes = this.readVarint(),
            str = this.buf.toString('utf8', this.pos, this.pos + bytes);
        this.pos += bytes;
        return str;
    },

    readBytes: function() {
        var bytes = this.readVarint();
        var buffer = this.buf.slice(this.pos, this.pos + bytes);
        this.pos += bytes;
        return buffer;
    },

    readPacked: function(type) {
        var bytes = this.readVarint();
        var end = this.pos + bytes;
        var array = [];
        var read = this['read' + type];
        while (this.pos < end) {
            array.push(read.call(this));
        }
        return array;
    },

    skip: function(val) {
        var type = val & 0x7;

        if (type === Protobuf.Varint) {
            var buf = this.buf;
            while (buf[this.pos++] > 0x7f);

        } else if (type === Protobuf.Bytes) {
            var bytes = this.readVarint();
            this.pos += bytes;

        } else if (type === Protobuf.Fixed32) this.pos += 4;
        else if (type === Protobuf.Fixed64) this.pos += 8;
        else throw new Error('Unimplemented type: ' + type);
    },

    // === WRITING =================================================================

    writeTag: function(tag, type) {
        this.writeVarint((tag << 3) | type);
    },

    realloc: function(min) {
        var length = this.length || 1;

        while (length < this.pos + min) length *= 2;

        if (length != this.length) {
            var buf = new Buffer(length);
            this.buf.copy(buf);
            this.buf = buf;
            this.length = length;
        }
    },

    finish: function() {
        this.length = this.pos;
        this.pos = 0;
        return this.buf.slice(0, this.length);
    },

    writePacked: function(tag, type, items) {
        if (!items.length) return;

        var message = new Protobuf();
        var write = message['write' + type];
        for (var i = 0; i < items.length; i++) {
            write.call(message, items[i]);
        }
        var data = message.finish();

        this.writeTag(tag, Protobuf.Bytes);
        this.writeBytes(data);
    },

    writeFixed32: function(val) {
        this.realloc(4);
        this.buf.writeUInt32LE(val, this.pos);
        this.pos += 4;
    },

    writeSFixed32: function(val) {
        this.realloc(4);
        this.buf.writeInt32LE(val, this.pos);
        this.pos += 4;
    },

    writeFixed64: function(val) {
        this.realloc(8);
        this.buf.writeInt32LE(val & -1, this.pos);
        this.buf.writeUInt32LE(Math.floor(val * SHIFT_RIGHT_32), this.pos + 4);
        this.pos += 8;
    },

    writeSFixed64: function(val) {
        this.realloc(8);
        this.buf.writeInt32LE(val & -1, this.pos);
        this.buf.writeInt32LE(Math.floor(val * SHIFT_RIGHT_32), this.pos + 4);
        this.pos += 8;
    },

    writeVarint: function(val) {
        val = +val;

        if (val <= 0x7f) {
            this.realloc(1);
            this.buf[this.pos++] = val;
        } else if (val <= 0x3fff) {
            this.realloc(2);
            this.buf[this.pos++] = 0x80 | ((val >>> 0) & 0x7f);
            this.buf[this.pos++] = 0x00 | ((val >>> 7) & 0x7f);
        } else if (val <= 0x1fffff) {
            this.realloc(3);
            this.buf[this.pos++] = 0x80 | ((val >>> 0) & 0x7f);
            this.buf[this.pos++] = 0x80 | ((val >>> 7) & 0x7f);
            this.buf[this.pos++] = 0x00 | ((val >>> 14) & 0x7f);
        } else if (val <= 0xfffffff) {
            this.realloc(4);
            this.buf[this.pos++] = 0x80 | ((val >>> 0) & 0x7f);
            this.buf[this.pos++] = 0x80 | ((val >>> 7) & 0x7f);
            this.buf[this.pos++] = 0x80 | ((val >>> 14) & 0x7f);
            this.buf[this.pos++] = 0x00 | ((val >>> 21) & 0x7f);
        } else {
            var pos = this.pos;
            while (val >= 0x80) {
                this.realloc(1);
                this.buf[this.pos++] = (val & 0xff) | 0x80;
                val /= 0x80;
            }
            this.realloc(1);
            this.buf[this.pos++] = val | 0;
            if (this.pos - pos > 10) throw new Error("Given varint doesn't fit into 10 bytes");
        }
    },

    writeSVarint: function(val) {
        this.writeVarint(val < 0 ? -val * 2 - 1 : val * 2);
    },

    writeBoolean: function(val) {
        this.writeVarint(Boolean(val));
    },

    writeString: function(str) {
        str = String(str);
        var bytes = Buffer.byteLength(str);
        this.writeVarint(bytes);
        this.realloc(bytes);
        this.buf.write(str, this.pos);
        this.pos += bytes;
    },

    writeFloat: function(val) {
        this.realloc(4);
        this.buf.writeFloatLE(val, this.pos);
        this.pos += 4;
    },

    writeDouble: function(val) {
        this.realloc(8);
        this.buf.writeDoubleLE(val, this.pos);
        this.pos += 8;
    },

    writeBytes: function(buffer) {
        var len = buffer.length;
        this.writeVarint(len);
        this.realloc(len);
        for (var i = 0; i < len; i++) {
            this.buf[this.pos + i] = buffer[i];
        }
        this.pos += len;
    },

    writeBytesField: function(tag, buffer) {
        this.writeTag(tag, Protobuf.Bytes);
        this.writeBytes(buffer);
    },

    writeMessage: function(tag, protobuf) {
        var buffer = protobuf.finish();
        this.writeTag(tag, Protobuf.Bytes);
        this.writeBytes(buffer);
    },

    writeFixed32Field: function(tag, val) {
        this.writeTag(tag, Protobuf.Fixed32);
        this.writeFixed32(val);
    },

    writeSFixed32Field: function(tag, val) {
        this.writeTag(tag, Protobuf.Fixed32);
        this.writeSFixed32(val);
    },

    writeFixed64Field: function(tag, val) {
        this.writeTag(tag, Protobuf.Fixed64);
        this.writeFixed64(val);
    },

    writeSFixed64Field: function(tag, val) {
        this.writeTag(tag, Protobuf.Fixed64);
        this.writeSFixed64(val);
    },

    writeVarintField: function(tag, val) {
        this.writeTag(tag, Protobuf.Varint);
        this.writeVarint(val);
    },

    writeSVarintField: function(tag, val) {
        this.writeTag(tag, Protobuf.Varint);
        this.writeSVarint(val);
    },

    writeStringField: function(tag, str) {
        this.writeTag(tag, Protobuf.Bytes);
        this.writeString(str);
    },

    writeFloatField: function(tag, val) {
        this.writeTag(tag, Protobuf.Fixed32);
        this.writeFloat(val);
    },

    writeDoubleField: function(tag, val) {
        this.writeTag(tag, Protobuf.Fixed64);
        this.writeDouble(val);
    },

    writeBooleanField: function(tag, val) {
        this.writeVarintField(tag, Boolean(val));
    }
};
