
import * as protobuf from './protobuf.js';

const uff = {};

uff.ModelFactory = class {

    match(context) {
        const identifier = context.identifier;
        const extension = identifier.split('.').pop().toLowerCase();
        if (extension === 'uff' || extension === 'pb') {
            const tags = context.tags('pb');
            if (tags.size > 0 &&
                tags.has(1) && tags.get(1) === 0 &&
                tags.has(2) && tags.get(2) === 0 &&
                tags.has(3) && tags.get(3) === 2 &&
                tags.has(4) && tags.get(4) === 2 &&
                (!tags.has(5) || tags.get(5) === 2)) {
                return 'uff.pb';
            }
        }
        if (extension === 'pbtxt' || identifier.toLowerCase().endsWith('.uff.txt')) {
            const tags = context.tags('pbtxt');
            if (tags.has('version') && tags.has('descriptors') && tags.has('graphs')) {
                return 'uff.pbtxt';
            }
        }
        return undefined;
    }

    async open(context, target) {
        await context.require('./uff-proto');
        uff.proto = protobuf.get('uff').uff;
        let meta_graph = null;
        switch (target) {
            case 'uff.pb': {
                try {
                    const stream = context.stream;
                    const reader = protobuf.BinaryReader.open(stream);
                    meta_graph = uff.proto.MetaGraph.decode(reader);
                } catch (error) {
                    const message = error && error.message ? error.message : error.toString();
                    throw  new uff.Error(`File format is not uff.MetaGraph (${message.replace(/\.$/, '')}).`);
                }
                break;
            }
            case 'uff.pbtxt': {
                try {
                    const stream = context.stream;
                    const reader = protobuf.TextReader.open(stream);
                    meta_graph = uff.proto.MetaGraph.decodeText(reader);
                } catch (error) {
                    throw new uff.Error(`File text format is not uff.MetaGraph (${error.message}).`);
                }
                break;
            }
            default: {
                throw new uff.Error(`Unsupported UFF format '${target}'.`);
            }
        }
        const metadata = await context.metadata('uff-metadata.json');
        return new uff.Model(metadata, meta_graph);
    }
};

uff.Model = class {

    constructor(metadata, meta_graph) {
        const version = meta_graph.version;
        this.format = `UFF${version ? ` v${version}` : ''}`;
        this.imports = meta_graph.descriptors.map((descriptor) => `${descriptor.id} v${descriptor.version}`);
        const references = new Map(meta_graph.referenced_data.map((item) => [ item.key, item.value ]));
        for (const graph of meta_graph.graphs) {
            for (const node of graph.nodes) {
                for (const field of node.fields) {
                    if (field.value.type === 'ref' && references.has(field.value.ref)) {
                        field.value = references.get(field.value.ref);
                    }
                }
            }
        }
        this.graphs = meta_graph.graphs.map((graph) => new uff.Graph(metadata, graph));
    }
};

uff.Graph = class {

    constructor(metadata, graph) {
        this.name = graph.id;
        this.inputs = [];
        this.outputs = [];
        this.nodes = [];
        const values = new Map();
        const counts = new Map();
        for (const node of graph.nodes) {
            for (const input of node.inputs) {
                counts.set(input, counts.has(input) ? counts.get(input) + 1 : 1);
                values.set(input, new uff.Value(input));
            }
            if (!values.has(node.id)) {
                values.set(node.id, new uff.Value(node.id));
            }
        }
        const value = (name) => {
            return values.get(name);
        };
        for (let i = graph.nodes.length - 1; i >= 0; i--) {
            const node = graph.nodes[i];
            if (node.operation === 'Const' && node.inputs.length === 0 && counts.get(node.id) === 1) {
                const fields = {};
                for (const field of node.fields) {
                    fields[field.key] = field.value;
                }
                if (fields.dtype && fields.shape && fields.values) {
                    const tensor = new uff.Tensor(fields.dtype.dtype, fields.shape, fields.values);
                    values.set(node.id, new uff.Value(node.id, tensor.type, tensor));
                    graph.nodes.splice(i, 1);
                }
            }
            if (node.operation === 'Input' && node.inputs.length === 0) {
                const fields = {};
                for (const field of node.fields) {
                    fields[field.key] = field.value;
                }
                const type = fields.dtype && fields.shape ? new uff.TensorType(fields.dtype.dtype, fields.shape) : null;
                values.set(node.id, new uff.Value(node.id, type, null));
            }
        }
        for (const node of graph.nodes) {
            if (node.operation === 'Input') {
                this.inputs.push(new uff.Argument(node.id, [ values.get(node.id) ]));
                continue;
            }
            if (node.operation === 'MarkOutput' && node.inputs.length === 1) {
                this.outputs.push(new uff.Argument(node.id, [ values.get(node.inputs[0]) ]));
                continue;
            }
            this.nodes.push(new uff.Node(metadata, node, value));
        }
    }
};

uff.Argument = class {

    constructor(name, value) {
        this.name = name;
        this.value = value;
    }
};

uff.Value = class {

    constructor(name, type, initializer) {
        if (typeof name !== 'string') {
            throw new uff.Error(`Invalid value identifier '${JSON.stringify(name)}'.`);
        }
        this.name = name;
        this.type = type || null;
        this.initializer = initializer || null;
    }
};

uff.Node = class {

    constructor(metadata, node, value) {
        this.name = node.id;
        this.type = metadata.type(node.operation) || { name: node.operation };
        this.attributes = [];
        this.inputs = [];
        this.outputs = [];
        if (node.inputs && node.inputs.length > 0) {
            let index = 0;
            if (this.type && this.type.inputs) {
                for (const metadata of this.type.inputs) {
                    if (index < node.inputs.length || metadata.optional !== true) {
                        const count = metadata.list ? (node.inputs.length - index) : 1;
                        const values = node.inputs.slice(index, index + count).map((name) => value(name));
                        index += count;
                        this.inputs.push(new uff.Argument(metadata.name, values));
                    }
                }
            }
            this.inputs.push(...node.inputs.slice(index).map((identifier, i) => {
                const name = ((index + i) === 0) ? 'input' : (index + i).toString();
                return new uff.Argument(name, [ value(identifier) ]);
            }));
        }
        this.outputs.push(new uff.Argument('output', [ value(node.id) ]));
        for (const field of node.fields) {
            const attribute = new uff.Attribute(field.key, field.value);
            this.attributes.push(attribute);
        }
    }
};

uff.Attribute = class {

    constructor(name, value) {
        this.name = name;
        switch (value.type) {
            case 's': this.value = value.s; this.type = 'string'; break;
            case 's_list': this.value = value.s_list; this.type = 'string[]'; break;
            case 'd': this.value = value.d; this.type = 'float64'; break;
            case 'd_list': this.value = value.d_list.val; this.type = 'float64[]'; break;
            case 'b': this.value = value.b; this.type = 'boolean'; break;
            case 'b_list': this.value = value.b_list; this.type = 'boolean[]'; break;
            case 'i': this.value = value.i; this.type = 'int64'; break;
            case 'i_list': this.value = value.i_list.val; this.type = 'int64[]'; break;
            case 'blob': this.value = value.blob; break;
            case 'ref': this.value = value.ref; this.type = 'ref'; break;
            case 'dtype': this.value = new uff.TensorType(value.dtype, null).dataType; this.type = 'uff.DataType'; break;
            case 'dtype_list': this.value = value.dtype_list.map((type) => new uff.TensorType(type, null).dataType); this.type = 'uff.DataType[]'; break;
            case 'dim_orders': this.value = value.dim_orders; break;
            case 'dim_orders_list': this.value = value.dim_orders_list.val; break;
            default: throw new uff.Error(`Unsupported attribute '${name}' value '${JSON.stringify(value)}'.`);
        }
    }
};

uff.Tensor = class {

    constructor(dataType, shape, values) {
        this.type = new uff.TensorType(dataType, shape);
        switch (values.type) {
            case 'blob': this.values = values.blob; break;
            default: throw new uff.Error(`Unsupported values format '${JSON.stringify(values.type)}'.`);
        }
        if (this.values.length > 8 &&
            this.values[0] === 0x28 && this.values[1] === 0x2e && this.values[2] === 0x2e && this.values[3] === 0x2e &&
            this.values[this.values.length - 1] === 0x29 && this.values[this.values.length - 2] === 0x2e && this.values[this.values.length - 3] === 0x2e && this.values[this.values.length - 4] === 0x2e) {
            this.values = null;
        }
    }
};

uff.TensorType = class {

    constructor(dataType, shape) {
        switch (dataType) {
            case uff.proto.DataType.DT_INT8: this.dataType = 'int8'; break;
            case uff.proto.DataType.DT_INT16: this.dataType = 'int16'; break;
            case uff.proto.DataType.DT_INT32: this.dataType = 'int32'; break;
            case uff.proto.DataType.DT_INT64: this.dataType = 'int64'; break;
            case uff.proto.DataType.DT_FLOAT16: this.dataType = 'float16'; break;
            case uff.proto.DataType.DT_FLOAT32: this.dataType = 'float32'; break;
            case 7: this.dataType = '?'; break;
            default: throw new uff.Error(`Unsupported data type '${JSON.stringify(dataType)}'.`);
        }
        this.shape = shape ? new uff.TensorShape(shape) : null;
    }

    toString() {
        return this.dataType + this.shape.toString();
    }
};

uff.TensorShape = class {

    constructor(shape) {
        if (shape.type !== 'i_list') {
            throw new uff.Error(`Unsupported shape format '${JSON.stringify(shape.type)}'.`);
        }
        this.dimensions = shape.i_list.val;
    }

    toString() {
        if (this.dimensions && this.dimensions.length > 0) {
            return `[${this.dimensions.join(',')}]`;
        }
        return '';
    }
};

uff.Error = class extends Error {

    constructor(message) {
        super(message);
        this.name = 'Error loading UFF model.';
    }
};

export const ModelFactory = uff.ModelFactory;

